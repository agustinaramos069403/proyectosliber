# WhatsApp bot — test cases (manual QA checklist)

## IA central (OpenAI)
- Requiere `OPENAI_API_KEY` en Netlify; con `OPENAI_AI_FIRST_ROUTING=true` (default) casi todo mensaje pasa por el router IA antes de reglas.
- Router principal: `decidePrimaryIntentWithOpenAi` → ADDRESS, HEALTH_INSURANCE, CONSULTATION_PRICE, BOOKING, SCHEDULE, etc.
- Clasificadores IA-first (OpenAI primero, reglas solo si falla o no hay key): dirección, obra social, precio consulta, horarios, confirmación link, autoagendado asistido (“agendame vos”), disconformidad/enojo (“muy caro”), respuestas abrumadoras.
- Excepciones sin router: emergencia, saludo puro, despedida, respuesta de sede en ventana de selección, confirmación de link (`awaiting_link_confirmation`).

## Sedes (selección, typos, claridad)
- Pregunta de sede con menú:
  - Usuario no entiende: “No entiendo”, “¿Qué tengo que poner?”, “¿Qué es 1 Corrientes?”, “No sé cuál es mi sede”
  - Respuesta vago en selección: “sí”, “ok”, “dale”, “no sé”, “cualquiera”
- Typos fuertes de sede:
  - Corrientes: “corriente”, “ctes”, “capital corrientes”
  - Resistencia: “resis”, “resi”, “resitencia”, “rcia”, “chaco”
  - Tras “¿Desde qué ciudad consultás?”: “de resis” / “resis” → “Sí, el Dr. atiende en Resistencia. ¿En qué te puedo ayudar?” (NO mensaje genérico de estudios ni link)
  - Tras redirección desde BS AS: “resis” → confirmar sede y preguntar en qué ayudar (NO arrastrar contexto viejo de precio de estudio)
  - Si la IA pide ciudad, guardar `awaiting_sede_selection` para interpretar la respuesta
- Sedes fuera de cobertura (Formosa, Sáenz Peña, etc.):
  - Respuesta: solo atiende en Corrientes y Resistencia; pedir cuál de esas dos
- Ciudades fuera de cobertura (Buenos Aires / CABA / etc.):
  - “atienden en bs as?” → “No, el Dr. no atiende en Buenos Aires. Atiende solo en Corrientes o Resistencia…” (NO ofrecer link de agenda)
  - Typos/abreviaturas: “bs as”, “bsas”, “buenos aires”, “caba”
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

## Obra social / prepaga
- “tengo obra social Pani/PAMI”, “soy de OSDE” → IA clasifica HEALTH_INSURANCE (NO horarios ni link de agenda)
- Typos: “Pani” → PAMI
- PAMI no aceptada: “En Corrientes no trabajamos con PAMI.” (sin link de turno en el mismo mensaje)
- Con sede ya en contexto (usuario que vuelve): responder aceptación/plus sin pedir ciudad de nuevo

## Dirección / ubicación
- “dónde está la clínica”, “dirección del consultorio”, “cómo llego”, “me pasás la ubi” → dirección/maps (NO ofrecer link de turno)
- Con sede ya informada (ej. Corrientes tras precio consulta): responder dirección de esa sede sin pedir ciudad de nuevo
- IA clasifica ADDRESS vs BOOKING cuando la frase es ambigua

## Turnos / reservas / link
- Flujo con contexto (IA + estado):
  - “quiero un turno” → sede → **NO** “¿en qué te puedo ayudar?”; ofrecer link o “¿te lo mando?”
  - “qué días atiende?” → IA clasifica SCHEDULE → ofrecer link (NO horarios de clínica)
  - Tras ofrecer link/horarios del Dr.: “martes por favor” → IA clasifica PREFERRED_DAY → ofrecer link para ver turno el martes (NO volver a pedir sede)
  - Responder “1” o “ctes” después de pedir sede para turno debe continuar agendamiento, no resetear conversación
- Después de precio de estudio (espirometría/test) con sede y obra social ya informadas:
  - “perfecto, entonces para agendar turno como hago?” → explicar proceso o pasar link (NO mensaje de “no abre el link”)
  - “quiero agendar” → no volver a pedir sede si ya dijo Corrientes/Resistencia; ofrecer link
- Intención de reservar:
  - “quiero reservar”, “quiero un turno”, “necesito turno”, “agendar”, “reservar”, “cita”
  - Typos: “urno”, “un urno”
- Pedido explícito de link:
  - “pasame el link”, “mandame el link”, “enviame el enlace”
- Confirmación de link (humanizada, sin “respondé sí o no”; OpenAI interpreta la intención):
  - “sí”, “dale”, “ok”, “por favor”, “listo”
  - Después de ofrecer el link: “por favor quiero agendar” → enviar link directo (no repetir la pregunta)
  - Variaciones naturales: “bueno dale”, “me interesa”, “avancemos”, “joya pasame”
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
- Pedir que la asistente agende (después de enviar el link):
  - Bot envió link Calendly → “¿Agéndame vos?” / “podés agendarme?”
  - IA clasifica autoagendado asistido (NO BOOKING ni micro-compromiso “¿Te lo mando?”)
  - Respuesta: explicar que por acá no se agenda + repetir el link ya enviado (NO “Sin problema, sin apuro” de rechazo de link)
- Horarios libres después del link:
  - Tras enviar link → “decime qué horarios tenés libre”
  - NO repetir “¿Te paso el link?”; indicar que la disponibilidad está en el link ya enviado
- Disconformidad / enojo (IA):
  - Tras precio/plus (“Con IOSCOR, plus de $35.000…”) → “Muy caro”, “estoy enojado”, “qué bronca”
  - NO repetir el mismo monto; IA genera respuesta empática breve (fallback sin OpenAI si no hay key)
  - Turno con día y hora (“martes 17hs”): explicar que por acá no se confirman horarios puntuales + link

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
  - “cuánto cuesta espirometría/prick/parche” no debe activar el precio de consulta; pedir obra social y sede para el estudio
  - Typos de espirometría: “estirometria”, “espirometria” → mismo flujo de precio de estudio (no $40.000 de consulta)
  - “precio de la consulta” / “preio de la consulta” / “qué costo tiene la consulta” (sin decir particular) → pedir ciudad y luego obra social; recién después plus/aceptación + valor particular de referencia
  - Tras pedir ciudad por costo consulta genérico: “ctes” / “Corrientes” → “¿qué obra social/prepaga tenés?” (NO $45.000 particular directo)
  - “consulta particular” / “y particular?” → precio particular desde Sheets tras ciudad (sin pedir obra social)
  - Tras OS en flujo de costo consulta genérico: “OSDE” → solo plus/aceptación (ej. “En Corrientes trabajamos con OSDE sin plus.”). NO link de turno ni particular en el mismo mensaje; esperar próxima pregunta
  - Si el paciente después pregunta turno o particular, responder solo eso en cada mensaje
  - Después de hablar de precio de estudio: “precio consulta particular?” → precio de consulta desde Google Sheets (NO mandar link de agenda por la palabra “consulta”)
  - Router OpenAI primero (con contexto de sede/estudio previo) para desambiguar precio consulta vs agendar vs estudio

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
  - “¿tengo que llevar algo especial para hacerme la espirometría?” → preparación (no ayunas, sin aerosoles ese día, DNI/credencial), NO confundir con “estudios previos a traer”
  - Follow-up sin repetir el estudio (después de precio de espirometría): “genial debo llevar algo especial?” → preparación vía IA (usa `lastStudyType` en contexto), NO mensaje de estudios previos
  - Typos: “estirometria” en preguntas de preparación → misma respuesta de espirometría
  - Preparación de estudios: siempre intenta OpenAI primero (con sede/estudio en contexto); si falla, respuesta fija de respaldo
  - Precio de estudio nuevo sin obra social en el mensaje: “hola precio de estirometria?” → pedir obra social y ciudad (no reutilizar IOSCOR/sede de sesiones viejas)
  - Mensaje combinado obra social + ciudad (IA primero): “osde y soy de corrientes” tras pedir datos para espirometría → precio con OSDE en Corrientes y guardar sede/OS en estado (NO volver a pedir ciudad después)
  - Tras precio espirometría + OSDE + Corrientes: “perfecto y para mañana hay turno?” → link o micro-compromiso en Corrientes (NO “¿para qué sede es?”)
  - Follow-up de precio de estudio (IA + reglas): tras “¿Querés que te cuente el valor o preferís agendar?” con espirometría + IOSCOR + Resistencia, “si dame el precio” → plus + $30.000 del estudio (NO $45.000 de consulta particular sola)
  - Router OpenAI: token `STUDY_PRICE` vs `PRIVATE_PRICE`; contexto incluye último mensaje del bot (`lastBotReplyText`)
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
  - Respuesta: dirección + **horarios de la clínica** (recepción) + cómo llegar si aplica
- “¿Qué días atiende el Dr.?” / “¿En qué horarios atiende?” / “horario de consulta”
  - Respuesta: **NO** listar horarios del Dr. ni horarios de clínica; ofrecer link para ver días/horarios disponibles en agenda (por acá no se agendan)
  - Tras esa respuesta: “martes por favor” → deducir turno el martes + ofrecer link (NO volver a pedir sede, NO confirmar horario por chat)
- “ubicación / pasame la ubi / maps / pin”
  - Respuesta: dirección y luego link de Google Maps (por sede).

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

