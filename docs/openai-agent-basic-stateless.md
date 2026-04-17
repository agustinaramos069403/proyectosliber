# Agente básico sin memoria (OpenAI + webhook WhatsApp)

Este documento describe la opción implementada en `netlify/functions/meta-whatsapp-webhook.cjs`: un **asistente conversacional stateless** que usa la **API de OpenAI (Chat Completions)** cuando el mensaje del usuario **no** coincide con una sede, y reglas de **seguridad y negocio** codificadas en el *system prompt* y en la lógica previa al modelo.

---

## 1. Qué significa “sin memoria”

| Concepto | Comportamiento |
|----------|----------------|
| **Stateless** | Cada mensaje de texto se procesa de forma **aislada**. No hay historial enviado al modelo: solo `system` + el último `user` message. |
| **Sin base de datos** | No se persiste conversación, preferencias ni “paso del funnel” entre mensajes. |
| **Implicación UX** | Si el usuario escribe “hola” y luego “quiero el 2”, el modelo **no** “recuerda” el saludo; el **2** lo resuelve la **lógica determinística** (`findSedeFromText`), no el LLM. |
| **Ventaja operativa** | Menor complejidad, sin Redis/Postgres, menos superficie de fallo y menos datos personales almacenados. |

La “memoria” útil para agendar sigue viniendo del **usuario** (elige sede en un mensaje) y de **reglas fijas** (match de sede → link desde variables de entorno).

---

## 2. Arquitectura técnica (alto nivel)

```
WhatsApp (Meta Cloud API) → POST webhook Netlify
  → parse payload (mensajes de texto)
  → por cada mensaje:
       1) findSedeFromText(body)
       2a) si hay sede → buildLinkMessage(sede)  [sin OpenAI]
       2b) si no hay sede → fetchOpenAiAssistantReply(body)  [OpenAI]
            → si OpenAI OK → enviar respuesta del modelo
            → si falla o no hay OPENAI_API_KEY → buildAskSedeMessage()  [fallback fijo]
  → Graph API: envío de texto (preview_url: true)
```

**Endpoints externos**

- **Meta Graph API**: `POST https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages` (salida hacia WhatsApp).
- **OpenAI**: `POST https://api.openai.com/v1/chat/completions` (entrada al modelo).

**Variables de entorno relevantes**

| Variable | Rol |
|----------|-----|
| `OPENAI_API_KEY` | Habilita la rama OpenAI; si está vacía, solo fallback fijo. |
| `OPENAI_MODEL` | Opcional; por defecto `gpt-4o-mini`. |
| `CALENDLY_*` | URLs de agenda por sede; **solo** el código las inyecta al mensaje final, no el LLM. |

**Parámetros de la llamada OpenAI (implementación actual)**

- `temperature`: `0.6` (algo de variación, sin ser errático).
- `max_tokens`: `400` (tope de respuesta; acota costo y longitud en WhatsApp).

---

## 3. Capas de “reglas”

### 3.1 Reglas duras (código, no negociables)

Estas reglas **no** dependen del modelo:

1. **Detección de sede** por texto normalizado (minúsculas, sin acentos) y por dígitos `1`–`4`.
2. **Enlaces de agenda**: solo si `process.env[CALENDLY_*]` existe y empieza con `http`; el mensaje con URL lo arma `buildLinkMessage`, no el LLM.
3. **Fallback**: si OpenAI no está configurado o la API falla, se envía el texto fijo de `buildAskSedeMessage()`.

### 3.2 Reglas blandas (system prompt → modelo)

El *system prompt* (en inglés en el código) instruye al modelo para que, en **español (Argentina)**:

- Ante **solo saludos / small talk ligero**: como máximo **dos oraciones cortas** (p. ej. saludo + “¿en qué puedo ayudarte?”), **sin** enumerar las cuatro sedes.
- Cuando el usuario pida **turno, agenda, sede o consulta**: entonces listar las **cuatro sedes** (1–4) o pedir que elijan por nombre.
- **No** dar diagnósticos ni consejos médicos de tratamiento; derivar a consulta presencial.
- **No** inventar cobertura de obras sociales; indicar que cambia y debe confirmarse con el consultorio.
- Cuando toque hablar de sedes para agendar, listar **exactamente cuatro** opciones con los nombres acordados (número + nombre de institución).
- Texto **plano** (sin markdown de encabezados); uso esporádico de `*` estilo WhatsApp.
- **No** inventar URLs de reserva; el sistema envía el link cuando el usuario elige sede.

Referencia literal en código: arreglo `systemPrompt` dentro de `fetchOpenAiAssistantReply` en `meta-whatsapp-webhook.cjs`.

---

## 4. Ejemplos de cómo se “materializan” las reglas

No son plantillas fijas de salida (el modelo varía el wording), pero ilustran el **comportamiento esperado**:

**Entrada usuario:** `Hola, ¿cómo estás?`  
**Salida esperada (estilo):** una o dos frases (p. ej. “¿En qué puedo ayudarte?”) **sin** lista 1–4.

**Entrada usuario:** `Quiero agendar un turno`  
**Salida esperada (estilo):** mencionar las cuatro sedes o pedir que elijan por número o nombre.

**Entrada usuario:** `¿Me cubre OSDE el consultorio?`  
**Salida esperada (estilo):** no afirmar cobertura; decir que depende del plan y que lo confirmen con administración/recepción; ofrecer elegir sede para agendar.

**Entrada usuario:** `Tengo mucha tos, ¿qué me tomo?`  
**Salida esperada (estilo):** no prescribir; sugerir consulta presencial; no alarmismo; puede redirigir a elegir sede si encaja con el flujo.

**Entrada usuario:** `Corrientes`  
**Comportamiento:** **no** pasa por OpenAI: el código detecta sede y envía el mensaje con link (`CALENDLY_CORRIENTES`) o mensaje de link no configurado.

---

## 5. Costos de usar la API de OpenAI

### 5.1 Cómo se cobra (modelo chat)

OpenAI factura por **tokens** (aprox. trozos de palabra/subpalabra). En cada llamada intervienen:

- **Tokens de entrada**: *system prompt* + mensaje del usuario (y metadatos del formato JSON de la API).
- **Tokens de salida**: texto generado por el modelo, acotado por `max_tokens` (400 en esta implementación).

Los precios **cambian** según modelo y política vigente. La fuente oficial es:

- [OpenAI API pricing](https://openai.com/api/pricing)

*(Consultar la fila del modelo configurado, p. ej. `gpt-4o-mini`.)*

### 5.2 Orden de magnitud (referencia, no presupuesto legal)

A fecha de documentación común de `gpt-4o-mini`, en la tabla pública de OpenAI suelen aparecer órdenes de magnitud del estilo **fracciones de USD por millón de tokens** de entrada y salida (valores exactos: solo en la URL anterior).

**Fórmula útil (estimación):**

\[
\text{costo USD} \approx \frac{\text{tokens\_in}}{10^6} \times P_{\text{in}} + \frac{\text{tokens\_out}}{10^6} \times P_{\text{out}}
\]

Donde \(P_{\text{in}}\) y \(P_{\text{out}}\) son el precio por millón de tokens de entrada y salida del modelo elegido.

**Ejemplo numérico ilustrativo** (sustituir \(P_{\text{in}}\), \(P_{\text{out}}\) por los vigentes en la web):

- Supongamos ~800 tokens de entrada (system largo + mensaje corto) y ~200 tokens de salida por conversación “hola + orientación sede”.
- Multiplicar por **N** conversaciones al mes que **no** matchean sede en el primer mensaje (solo esas llaman a OpenAI).

### 5.3 Otros costos a tener en cuenta

| Ítem | Nota |
|------|------|
| **WhatsApp Cloud API** | Meta cobra conversaciones según categoría y país; es independiente del costo OpenAI. |
| **Netlify Functions** | Incluido en el plan de Netlify con límites de invocaciones/tiempo; cada mensaje puede ser 1 invocación + 1 llamada HTTP a OpenAI. |
| **Crédito “gratis” OpenAI** | La API suele requerir **saldo/créditos**; no asumir gratuidad permanente para producción. |

### 5.4 Cómo bajar costo sin cambiar producto

- Mantener **`gpt-4o-mini`** (o modelos small) para tráfico inicial.
- Mantener **`max_tokens`** bajo (ya 400).
- Evitar reenviar historial (ya es stateless; no duplicar contexto).
- Opcional futuro: **cache** de respuestas para mensajes idénticos (no implementado hoy).

---

## 6. Limitaciones conocidas (diseño)

- **Sin contexto multi-turno en el LLM**: si el usuario da la sede en dos mensajes (“hola” y después “resistencia”), la segunda sí dispara link por código; la primera no “recuerda” la intención en el modelo.
- **Alucinación residual**: aunque el prompt prohíbe inventar coberturas/URLs, el modelo puede equivocarse; por eso los **links** y la **sede** crítica siguen en **código + env**.
- **Latencia**: cada mensaje no-sede añade RTT a OpenAI además de Meta.

---

## 7. Referencias en el repositorio

| Recurso | Ubicación |
|---------|-----------|
| Llamada OpenAI y system prompt | `netlify/functions/meta-whatsapp-webhook.cjs` → `fetchOpenAiAssistantReply` |
| Flujo webhook + ramas | mismo archivo → `exports.handler` |
| Flujo funcional resumido | `docs/whatsapp-bot-flow.md` |
