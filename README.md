# Landing Page - Dr. Liber Acosta | Sistema de Transformación 360™

Landing page de conversión a WhatsApp para el Dr. Liber Acosta, especialista en Alergia e Inmunología.

## Stack

- **Astro** - Framework estático optimizado para landing pages
- **Tailwind CSS** - Estilos utility-first
- **Netlify** - Hosting y despliegue

## Configuración

### WhatsApp

Edita `src/config.ts` y reemplaza `WHATSAPP_NUMBER` con el número real (formato: 549XXXXXXXXX para Argentina, sin + ni espacios).

### Foto del Dr. Liber

Coloca la foto principal en `public/dr-liber-acosta.jpg`. Si no existe, se mostrará un placeholder automáticamente.

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
