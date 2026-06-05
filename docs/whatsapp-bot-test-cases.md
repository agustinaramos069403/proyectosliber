# WhatsApp bot — test cases (manual QA checklist)

Este documento lista los casos/escenarios que fuimos probando y ajustando durante la iteración del bot.

## Sedes (selección, typos, claridad)
- Pregunta de sede con menú:
  - Usuario no entiende: “No entiendo”, “¿Qué tengo que poner?”, “¿Qué es 1 Corrientes?”, “No sé cuál es mi sede”
  - Respuesta vago en selección: “sí”, “ok”, “dale”, “no sé”, “cualquiera”
- Typos fuertes de sede:
  - Corrientes: “corriente”, “ctes”, “capital corrientes”
  - Resistencia: “resis”, “resi”, “resitencia”, “rcia”, “chaco”
- Sedes fuera de cobertura (Formosa, Sáenz Peña, etc.):
  - Respuesta: solo atiende en Corrientes y Resistencia; pedir cuál de esas dos
  - Opciones legacy “3” o “4”: redirigir a 1 Corrientes o 2 Resistencia
- Respuestas numéricas ambiguas:
  - “1” solo cuenta como sede si el bot estaba pidiendo sede (ventana de selección) o en estados relevantes.

## Saludos / small talk (evitar doble saludo)
- “hola”, “buenas”, “buen día”
- “¿cómo estás?”, “qué tal”
- Saludos compuestos (deben responder humano y sin pedir sede):
  - “buenos días, cómo estás?”
  - “hola, qué tal?”
  - “buenas tardes, todo bien?”
  - “hola, cómo va?”
- Saludo + intención en el mismo mensaje (no debe tratarlo como solo saludo):
  - “Hola, soy de Resis y tengo OSDE, ¿hay plus?”
  - “Hola, quiero turno”
  - “Buenas, cuánto sale la consulta”

## Turnos / reservas / link
- Después de precio de estudio (espirometría/test) con sede y obra social ya informadas:
  - “perfecto, entonces para agendar turno como hago?” → explicar proceso o pasar link (NO mensaje de “no abre el link”)
  - “quiero agendar” → no volver a pedir sede si ya dijo Corrientes/Resistencia; ofrecer link
- Intención de reservar:
  - “quiero reservar”, “quiero un turno”, “necesito turno”, “agendar”, “reservar”, “cita”
  - Typos: “urno”, “un urno”
- Pedido explícito de link:
  - “pasame el link”, “mandame el link”, “enviame el enlace”
- Confirmación de link (humanizada, sin “respondé sí o no”):
  - “sí”, “dale”, “ok”, “por favor”, “listo”
- Rechazo de link:
  - “no”, “no por ahora”, “más tarde”, “no quiero”
  - Negación con “quiero” adentro: “no no quiero” (NO debe ganar)
  - Sarcasmo: “sí, cómo no” (se interpreta como NO)
- Opt-out de insistencia:
  - Si el usuario dijo NO al link, el bot no debe insistir ofreciendo link en respuestas siguientes (salvo pedido explícito).
- Reservar sin link (por chat):
  - “no quiero link, agendame por chat”
  - “no tengo mail/email”
  - “no sé usar / no sé entrar / no sé reservar”
  - Derivación a equipo/secretaría

## Link — problemas técnicos / disponibilidad / lista de espera
- Problema técnico con el link:
  - “no me abre”, “no funciona”, “no carga”, “error en el link”
  - Flujo: tip simple (“Probá abrirlo desde otro navegador o desde la computadora…”), si insiste → derivación.
- Sin turnos disponibles:
  - “no hay turnos”, “sin turnos”, “no hay horarios disponibles”
  - Corrientes/Resistencia:
    - “la agenda se llena rápido…”
    - “revisar el link en unos días”
    - “si preferís lista de espera…”
  - Confirmación lista de espera:
    - Si dice sí → derivación (lista de espera)
    - Si dice no → cierre + link (si existe)

## Obras sociales / prepagas / plus
- Preguntas directas:
  - “atienden OSDE?”, “aceptan IOSCOR?”, “tengo Sancor…”
  - “¿qué prepagas aceptan?” (se pide cuál tiene, no lista)
- Genérico institucional (evitar inventar OS parecida):
  - “obra social del cardiológico”
  - Caso especial Corrientes cardiológico: responder “no cuento con esa info” + derivación
- Multi-intención OS + precio:
  - “Con IOSCOR en Corrientes, ¿hay plus y cuánto sale particular?”
  - Debe responder ambas (plus + precio consulta) en una sola respuesta.
- “No sé mi obra social / es la de mi mamá”:
  - Respuesta cálida: pedir nombre si lo recuerda (sin números) y si no, ver en consulta.

## Precios / particular / control
- “¿Cuánto sale la consulta?”, “¿Cuánto está la consulta?”, “¿Cuánto cuesta?”, “valor consulta”
- Variantes:
  - “consulta particular”, “y particular?”, “control”, “seguimiento”, “reconsulta”
- Regla:
  - Se usa 1 precio por sede (no se diferencia primera/control).
- Evitar confusión con estudios:
  - “cuánto cuesta espirometría/prick/parche” no debe activar el precio de consulta; deriva a consulta para confirmar.

## Estudios / prácticas
- Estudios detectados:
  - “prick test”, “test de alergia”, “espirometría”, “test del parche/patch”
- Estudios que el Dr. realiza vs. estudios que el paciente debe traer:
  - “¿qué estudios hace/realiza el Dr.?”, “¿hacen espirometría/prick en consulta?” → info de prácticas (Prick Test, espirometría, etc.) vía `messageAsksAboutStudiesOrTests`
  - “¿cuáles son los estudios que debo llevar?”, “¿qué estudios previos traigo?” → sí traer resultados/informes si ya los tiene + DNI + credencial/orden si tiene OS
  - “¿qué historia clínica / informes de otro médico debo llevar?” → sí traer informes/historia clínica + DNI + credencial/orden si aplica
  - “no tengo estudios previos / nunca me hice estudios” → podés venir igual; el Dr. evalúa en consulta
  - “¿qué estudios me van a pedir?” / “¿qué debo hacerme antes?” → depende del caso; se define en evaluación
  - “me mandaron a hacerme estudios antes de ir” → traer orden/informe y resultados si ya los tiene
  - “¿puedo llevar foto/PDF en el celular?” → sí en consulta; no enviar informes por este chat
  - Pediatría: “¿qué estudios lleva mi hijo/a?” → variante con DNI del menor
  - Con sede guardada (ej. Resistencia): mencionar la sede en la respuesta
- Precio de estudios:
  - “¿cuánto cuesta el prick test?” → “se confirma en consulta”
- Preparación de estudios:
  - Ayunas: “¿tengo que ir en ayunas?” → no
  - Medicación: antihistamínicos 48 hs, corticoides 1 semana; espirometría sin aerosoles ese día
  - “¿cuánto tarda el estudio?” → depende del caso
  - Alergia a medicamentos: requiere consulta previa, depende del protocolo

## Si atiende X condición (sin diagnóstico)
- “mi mamá tiene asma/rinitis/urticaria/dermatitis… ¿atienden eso?”
- Respuesta: sí atiende + “consulta de evaluación” (si hay sede, mencionarla)

## Pediatría (niños / ninos / ninios)
- “atiende niños?”, “atendes ninos?”, typo “ninios”
- Respuesta directa (sin “podés acercarte…”) + pedir sede solo si falta

## Emergencias (derivación guardia)
- Disparadores:
  - “no puedo respirar”, “me falta el aire”, “me ahogo”
  - “se me hinchó/cerró la garganta”, “se me hinchó la cara”
  - “anafilaxia/anafilaxis”, “shock”, “adrenalina/epipen”
  - “me desmayé”, “se descompensó”
  - “urgente/urgencia/emergencia”
- Mensaje: “El Dr. no atiende urgencias…” + guardia/107

## Documentación / requisitos / administración (FAQ)
- “¿Qué tengo que llevar?” / “¿qué debo llevar?” (orden + prácticas autorizadas si tiene OS)
- “¿Cuáles son los estudios que debo llevar?” → estudios previos (no confundir con prácticas del Dr.)
- “¿Necesito orden?”, “¿receta/derivación?” (no necesita)
- “¿Atienden con autorización?”, “¿aceptan credencial digital?” (sí)
- “¿Dan factura?” (sí)
- “¿Cómo pago?” (efectivo o transferencia/QR; tarjeta/débito no)
- “¿Cuánto dura la consulta?” (depende)
- “¿Puedo ir con acompañante?” (sí)
- “¿Atienden en otra provincia?” (no)
- “¿Hacen virtual/videollamada?” (sí)
- Nota: estas respuestas no deben volver a pedir sede si ya está guardada.

## Dirección / horarios / ubicación (Maps)
- “¿En qué dirección queda…?”, “¿Dónde queda…?”, “¿Cómo llego…?”
- “¿En qué horarios trabajan/atienden?”
- “ubicación / pasame la ubi / maps / pin”
  - Respuesta: dirección + horarios y luego link de Google Maps (por sede).

## Hablar con médico / secretaría / humano
- “¿Puedo hablar con el médico?” (no por WhatsApp; ofrecer ayudar a reservar)
- “secretaría/recepción/administración” (derivar)

## No-text (audio/imagen/documento)
- Si llega audio/imagen/documento:
  - Respuesta: “¿Me lo podés escribir…?”
  - Cooldown para no spamear si mandan varios seguidos.

## Privacidad / datos sensibles
- Texto con DNI/CUIL/afiliado o secuencias largas de números
- Imagen/documento (posible credencial)
- Respuesta: “no envíes datos sensibles por este chat” + pedir solo ciudad/OS sin números

## Robustez producción
- Deduplicación por `message.id` (evitar dobles respuestas por reintentos)
- Staleness: ignorar mensajes muy viejos o fuera de orden (timestamp vs `lastInboundMessageAtMs`)
- Rate limiting por usuario: cooldown corto para mensajes de bajo signal (evitar spam)

