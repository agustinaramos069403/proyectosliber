# Landing Page - Dr. Liber Acosta | Sistema de Transformación 360™

Landing page de conversión a WhatsApp para el Dr. Liber Acosta, especialista en Alergia e Inmunología.

## Stack

- **Astro** - Framework estático optimizado para landing pages
- **Tailwind CSS** - Estilos utility-first
- **Netlify** - Hosting y despliegue

## Configuración

### WhatsApp (número del chat humano)

Edita `src/config.ts` y reemplaza `WHATSAPP_NUMBER` con el número real (formato: `549XXXXXXXXXX` para Argentina, sin `+` ni espacios), o usá `PUBLIC_WHATSAPP_NUMBER` en Netlify. Los CTAs de agenda abren primero un **modal** para elegir una de las cuatro sedes; al elegir, se abre `wa.me` con un mensaje sobre el **Sistema 360** y la sede seleccionada (ver `buildWhatsAppBookingMessage` en `src/config.ts`).

### Bot de WhatsApp (Meta Cloud API)

Además del chat directo, el repo incluye un **asistente automático** vía [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/): cuando alguien escribe al **número de la API** (el que Meta asigna al negocio), Netlify recibe el webhook y el bot responde pidiendo sede o enviando el link de agenda.

**Archivo:** `netlify/functions/meta-whatsapp-webhook.cjs`

**Comportamiento:**

1. Llega un mensaje de texto del usuario.
2. Si el texto coincide con una sede (nombre, alias o número `1`–`4`), el bot responde con el link de esa sede (Calendly u otra URL).
3. Si no reconoce sede, responde con el menú numerado (Corrientes, Resistencia, Sáenz Peña, Formosa).

**URL del webhook** (después del deploy en Netlify):

`https://TU-SITIO.netlify.app/.netlify/functions/meta-whatsapp-webhook`

En Meta (App → WhatsApp → Configuration) configurá:

- **Callback URL:** la URL de arriba  
- **Verify token:** el mismo valor que `WHATSAPP_VERIFY_TOKEN` en Netlify  
- Suscribí el webhook al campo `messages`

**Variables de entorno en Netlify** (Site settings → Environment variables). Copiá también desde `env.example`:

| Variable | Uso |
|----------|-----|
| `WHATSAPP_VERIFY_TOKEN` | Token que definís vos; debe coincidir con el de Meta al verificar el webhook. |
| `WHATSAPP_ACCESS_TOKEN` | Token de la app (temporal de prueba o de usuario del sistema en producción). |
| `WHATSAPP_PHONE_NUMBER_ID` | ID del número de WhatsApp Business en la API (Meta → API setup). |
| `CALENDLY_CORRIENTES` | URL completa de reserva (https…) para esa sede. |
| `CALENDLY_RESISTENCIA` | Igual. |
| `CALENDLY_SAENZ_PENA` | Igual. |
| `CALENDLY_FORMOSA` | Igual. |
| `OPENAI_API_KEY` | Opcional. Si está definida, cuando el usuario no elige sede el bot responde con un texto breve vía OpenAI (modelo por defecto `gpt-4o-mini`) y orienta a elegir sede. |
| `OPENAI_MODEL` | Opcional. Sobrescribe el modelo de OpenAI (por defecto `gpt-4o-mini`). |

Si falta alguna URL de Calendly, el bot igual confirma la sede y pide que escriban horario por chat.

**Probar en local:** con [Netlify CLI](https://docs.netlify.com/cli/get-started/), en la carpeta `landing`:

```bash
netlify dev
```

La función queda en `http://localhost:8888/.netlify/functions/meta-whatsapp-webhook`. Para que Meta la alcance hace falta un túnel (ngrok, Cloudflare Tunnel, etc.) apuntando a ese path.

**Nota:** El número que abre la landing (`wa.me` + `WHATSAPP_NUMBER`) puede ser el **celular del consultorio**; el bot corre sobre el **número conectado a la Cloud API** en Meta. Pueden ser el mismo flujo de negocio si migrás el número a la API, o dos entradas distintas (humano vs bot).

#### Probar con número de test (sin usar el celular del consultorio en la API)

Sí, es lo habitual en desarrollo:

1. En [Meta for Developers](https://developers.facebook.com/), abrí tu app → **WhatsApp** → **API Setup** (o *Getting started*).
2. Meta te muestra un **número de prueba de WhatsApp Business** (no es tu SIM del consultorio). Ahí copiás el **Phone number ID** → va en `WHATSAPP_PHONE_NUMBER_ID`.
3. Generá un **temporary access token** (caduca en horas/días) → va en `WHATSAPP_ACCESS_TOKEN` mientras probás.
4. **Destinatarios permitidos en modo desarrollo:** Meta solo deja que escriban al número de prueba ciertos celulares que vos agregás a la lista (en la misma pantalla de API setup suele figurar *“To”* / *“Add phone number”* / pasos para registrar un número de prueba). **Podés usar tu propio celular** solo como *quien chatea* con el bot; el bot sigue saliendo del **número de test de Meta**, no del consultorio.
5. Configurá el webhook (URL pública + `WHATSAPP_VERIFY_TOKEN`) y escribí desde WhatsApp al **número de test** que muestra Meta: deberían dispararse el POST al webhook y las respuestas del bot.

Cuando pases a producción, conectás el número real del negocio a la app y reemplazás token / `phone_number_id` por los de producción.

### Foto del Dr. Liber

La foto principal está en `public/dr-liber-acosta.png`.

## Desarrollo

```bash
npm install
npm run dev
```

Abre http://localhost:4321

## Build

```bash
npm run build
```

Los archivos estáticos se generan en `dist/`.

## Despliegue en Netlify

1. Conecta el repositorio a Netlify
2. Configuración de build:
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
3. Deploy

O usa el CLI:

```bash
npm install -g netlify-cli
netlify deploy --prod
```

## Mobile First

La sección Hero está optimizada para verse completa en móviles sin scroll (100dvh).
