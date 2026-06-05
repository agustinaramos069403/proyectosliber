# Circuidddto del bot de WhatsApp (Meta Cloud API)

Este documento describe el flujo exacto del bot implementado en `netlify/functions/meta-whatsapp-webhook.cjs`, incluyendo los **mensajes literales** que envía.

## Qué endpoint es

- **Función**: `/.netlify/functions/meta-whatsapp-webhook`
- **Métodos**
  - **GET**: verificación del webhook (Meta `hub.challenge`)
  - **POST**: recepción de mensajes y respuestas automáticas

## Entradas qudde procesa (POST)

El bot solo procesa mensajes que cumplan:

- `msg.type === 'text'`
- `msg.text.body` existe (texto del usuario)

Todo lffo demád (statuses, templates, adjuntos, etc.) se ignora para respuesta automática.

## Detección de s33ede

El bot toma el texto entrante (`msg.text.body`) y:

- Recorta espacios (`trim`)
- Normaliza para comparar:
  - Pasa a minúsculas
  - Remueve acentos/diacríticos

Luego intenta identificar una sede de estas 2:

- **Corrientes** → `CALENDLY_CORRIENTES`
- **Resistencia** → `CALENDLY_RESISTENCIA`

### Coincidencias por número

Si el usuario responde exactamente con:

- `1` → Corrientes
- `2` → Resistencia

Si responde `3` o `4` (menú legacy), el bot redirige a las dos sedes activas.

### Coincidencias por texto (contiene o igual)

Si el texto normalizado **es igual** o **contiene** alguno de estos términos:

- **Corrientes**
  - `corrientes`, `clinica del pilar`, `pilar`
- **Resistencia**
  - `resistencia`, `resis`, `immi`, `chaco`, `instituto modelo de medicina infantil`, `instituto modelo medicina infantil`, `modelo de medicina infantil`

Menciones de Formosa, Sáenz Peña u otras ciudades sin atención reciben mensaje de que solo hay consultorio en Corrientes y Resistencia.

## Salidas (mensajes enviados)

Los mensajes se envían por WhatsApp Cloud API como texto con `preview_url: true`.

### Caso A — No se detecta sede (el usuario no la aclara)

**A1 — Con `OPENAI_API_KEY` configurada**

Se llama a la API de OpenAI (modelo por defecto `gpt-4o-mini`, configurable con `OPENAI_MODEL`). El texto **no es fijo**: ante un saludo suele ser muy breve (p. ej. tono “¿cómo estás? ¿en qué puedo ayudarte?”) **sin** listar las dos sedes de entrada; la lista 1–2 aparece cuando el usuario pide turno, sede o algo equivalente. No incluye URLs de agenda (el sistema envía el link solo cuando hay match de sede).

**A2 — Sin `OPENAI_API_KEY`, o si OpenAI falla**

El bot responde con este mensaje literal:

```text
No indiqué en qué sede querés agendar.

Elegí una opción (podés responder con el número o el nombre de la ciudad):

1 — Corrientes (Clínica del Pilar)
2 — Resistencia (Instituto Modelo de Medicina Infantil)

Cuando elijas, te envío el link para reservar turno.
```

### Caso B — Se detecta sede y la URL está configurada

Condición: existe la variable de entorno correspondiente y empieza con `http`.

Ejemplos:

- Corrientes: `CALENDLY_CORRIENTES=https://...`
- Resistencia: `CALENDLY_RESISTENCIA=https://...`

Mensaje literal enviado (con reemplazos):

```text
Perfecto, sede *{DISPLAY_NAME}*.

Agendá tu turno acá:
{AGENDA_URL}
```

Donde:

- `{DISPLAY_NAME}` es exactamente uno de:
  - `Corrientes`
  - `Resistencia`
- `{AGENDA_URL}` es el valor de la variable `CALENDLY_*` correspondiente.

### Caso C — Se detecta sede pero la URL NO está configurada

Condición: la variable `CALENDLY_*` falta o no empieza con `http`.

Mensaje literal enviado (con reemplazo):

```text
Recibimos tu preferencia por *{DISPLAY_NAME}*.

El link de agenda online todavía no está configurado.
Escribinos el horario preferido y te confirmamos por este chat.
```

## Resumen del circuito (paso a paso)

1. Llega `POST` del webhook de Meta con uno o más mensajes.
2. Para cada mensaje:
   - Si no es texto, se ignora.
   - Si es texto, se intenta detectar sede.
3. Si **no** detecta sede → intenta **Caso A1** (OpenAI); si no hay clave o falla la API → **Caso A2** (mensaje fijo).
4. Si detecta sede:
   - Si la URL existe y es válida → envía el **mensaje del Caso B**.
   - Si falta URL → envía el **mensaje del Caso C**.

