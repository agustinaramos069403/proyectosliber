# Circuito del bot de WhatsApp (Meta Cloud API)

Este documento describe el flujo exacto del bot implementado en `netlify/functions/meta-whatsapp-webhook.cjs`, incluyendo los **mensajes literales** que envía.

## Qué endpoint es

- **Función**: `/.netlify/functions/meta-whatsapp-webhook`
- **Métodos**
  - **GET**: verificación del webhook (Meta `hub.challenge`)
  - **POST**: recepción de mensajes y respuestas automáticas

## Entradas que procesa (POST)

El bot solo procesa mensajes que cumplan:

- `msg.type === 'text'`
- `msg.text.body` existe (texto del usuario)

Todo lo demás (statuses, templates, adjuntos, etc.) se ignora para respuesta automática.

## Detección de sede

El bot toma el texto entrante (`msg.text.body`) y:

- Recorta espacios (`trim`)
- Normaliza para comparar:
  - Pasa a minúsculas
  - Remueve acentos/diacríticos

Luego intenta identificar una sede de estas 4:

- **Corrientes** → `CALENDLY_CORRIENTES`
- **Resistencia** → `CALENDLY_RESISTENCIA`
- **Sáenz Peña** → `CALENDLY_SAENZ_PENA`
- **Formosa** → `CALENDLY_FORMOSA`

### Coincidencias por número

Si el usuario responde exactamente con:

- `1` → Corrientes
- `2` → Resistencia
- `3` → Sáenz Peña
- `4` → Formosa

### Coincidencias por texto (contiene o igual)

Si el texto normalizado **es igual** o **contiene** alguno de estos términos:

- **Corrientes**
  - `corrientes`, `clinica del pilar`, `pilar`
- **Resistencia**
  - `resistencia`, `immi`, `instituto modelo de medicina infantil`, `instituto modelo medicina infantil`, `modelo de medicina infantil`
- **Sáenz Peña**
  - `sáenz peña`, `saenz pena`, `saenz`, `santa maria`, `santa maría`
- **Formosa**
  - `formosa`, `gastroenterologia`, `gastroenterología`

## Salidas (mensajes enviados)

Los mensajes se envían por WhatsApp Cloud API como texto con `preview_url: true`.

### Caso A — No se detecta sede (el usuario no la aclara)

**A1 — Con `OPENAI_API_KEY` configurada**

Se llama a la API de OpenAI (modelo por defecto `gpt-4o-mini`, configurable con `OPENAI_MODEL`). El texto enviado al usuario **no es fijo**: es una respuesta breve en español (saludo si aplica) que orienta a elegir una de las cuatro sedes. No incluye URLs de agenda (el sistema envía el link solo cuando hay match de sede).

**A2 — Sin `OPENAI_API_KEY`, o si OpenAI falla**

El bot responde con este mensaje literal:

```text
No indiqué en qué sede querés agendar.

Elegí una opción (podés responder con el número o el nombre de la ciudad):

1 — Corrientes (Clínica del Pilar)
2 — Resistencia (Instituto Modelo de Medicina Infantil)
3 — Sáenz Peña (Clínica Santa María)
4 — Formosa (Inst. de Gastroenterología)

Cuando elijas, te envío el link para reservar turno.
```

### Caso B — Se detecta sede y la URL está configurada

Condición: existe la variable de entorno correspondiente y empieza con `http`.

Ejemplos:

- Corrientes: `CALENDLY_CORRIENTES=https://...`
- Resistencia: `CALENDLY_RESISTENCIA=https://...`
- Sáenz Peña: `CALENDLY_SAENZ_PENA=https://...`
- Formosa: `CALENDLY_FORMOSA=https://...`

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
  - `Sáenz Peña`
  - `Formosa`
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

