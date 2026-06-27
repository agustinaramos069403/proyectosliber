# WhatsApp bot — test cases (manual QA checklist)

## IA central (OpenAI)
- Requiere `OPENAI_API_KEY` en Netlify; con `OPENAI_AI_FIRST_ROUTING=true` (default) casi todo mensaje pasa por el router IA antes de reglas.
- Router principal: `decidePrimaryIntentWithOpenAi` → ADDRESS, HEALTH_INSURANCE, CONSULTATION_PRICE, BOOKING, SCHEDULE, etc.
- Clasificadores IA-first (OpenAI primero, reglas solo si falla o no hay key): dirección, obra social, precio consulta, horarios, confirmación link, autoagendado asistido (“agendame vos”), disconformidad/enojo (“muy caro”), problema con link (“no funciona”, “no anda”), respuestas abrumadoras.
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
- Chaco ambiguo (Resistencia vs Sáenz Peña):
  - “Soy de Chaco, tengo OSDE, necesito test de alergia” → preguntar Resistencia o Sáenz Peña (guardar OSDE en estado)
  - “Sáenz Peña” → confirmar sede + cobertura OSDE + aclarar que turnos en Sáenz Peña son por teléfono de la sede (NO link de Resistencia)
  - “para agendar turno?” con sede Sáenz Peña en contexto → teléfono de Sáenz Peña + “por acá solo se agenda online en Corrientes y Resistencia”
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

## Horarios especiales / disponibilidad / embarazo
- Fines de semana y feriados:
  - “¿Atiende los sábados?”, “¿y los domingos?”, “¿atiende feriados?”
  - Respuesta: NO atiende sábados, domingos ni feriados; orientar a agenda online o teléfono de sede según contexto.
- Demora / cupo en agenda:
  - “¿Cuánto tiempo tengo que esperar para un turno?”, “¿Hay turnos disponibles esta semana?”
  - Respuesta: por chat no se confirma demora ni cupo; disponibilidad en el link; a veces se liberan turnos por cancelaciones.
  - Con sede Corrientes/Resistencia: puede ofrecer link (NO afirmar que hay turno).
- Sin turno / walk-in:
  - “¿Puedo ir sin turno?”
  - Respuesta: NO, consultas con turno previo (link o teléfono de sede según corresponda).
- Embarazo:
  - “Estoy embarazada, ¿puedo hacerme el test de alergia?”, “¿el Dr. atiende embarazadas?”
  - Respuesta empática: sí atiende embarazadas; estudios pueden requerir evaluación previa; NO dar indicaciones médicas concretas.

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
  - “pasame el link”, “mandame el link”, “enviame el enlace”, “pásame link para agendar”
  - Con sede ya conocida → enviar link directo (NO “¿Te lo mando?”)
  - Tras “Muy caro” u objeción → si pide link, enviarlo en un solo paso
- Turno con día/hora sin sede:
  - “quiero turno el lunes a las 16hs” → pedir sede → al responder “Resistencia” → IA explica que por acá no se agenda + link directo (NO “¿Te lo mando?”)
- Confirmación de link (humanizada, sin “respondé sí o no”; OpenAI interpreta la intención):
  - “sí”, “dale”, “ok”, “por favor”, “listo”
  - Después de ofrecer el link: “por favor quiero agendar” → enviar link directo (no repetir la pregunta)
  - Variaciones naturales: “bueno dale”, “me interesa”, “avancemos”, “joya pasame”
- Confirmación de turno ya reservado (tras usar el link):
  - “Ya está! Ya quedó confirmado?”, “Si ya guardé quería saber si se confirma?”
  - Respuesta: aclarar que por chat no se confirman turnos + teléfono de la sede (Corrientes `3795063578`, Resistencia `3624571222`).
  - **No** repetir “Con el link que ya te pasé…” ni volver a ofrecer la agenda.
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
- Reprogramar / cancelar turno existente:
  - “Tengo turno el jueves pero quiero cambiarlo para otro día”, “quiero reprogramar mi turno”, “cancelar mi turno”
  - NO ofrecer link de agenda ni confirmar horarios nuevos por chat
  - Derivar al teléfono de sede guardada en contexto (Corrientes `3795063578` / Resistencia `3624571222`); si no hay sede, dar ambos números
  - Respuesta tipo: cambios los gestiona el equipo + teléfono de sede + pueden ayudar con nuevo horario
- Confirmar turno ya reservado:
  - “Ya saqué turno, ¿me lo confirmás?”, “quiero confirmar mi reserva”
  - NO confirmar horario/día por chat ni decir “te esperamos” como cierre genérico
  - Derivar al teléfono de sede; el equipo tiene acceso a la agenda
- Otras provincias:
  - NO solo “no atendemos”; ofrecer modalidad virtual + preguntar si quiere link online (`awaiting_virtual_visit_confirmation`)
- Consulta virtual:
  - Confirmar que hay modalidad virtual + “¿Querés que te comparta el link para agendar?” (no “¿Te sirve?”)
- Derivación / receta:
  - “No necesitás derivación ni receta.” sin cierre mecánico “¿Te sirve?”

## Link — problemas técnicos / disponibilidad / lista de espera
- Problema técnico con el link (IA + contexto de link enviado):
  - “no me abre”, “no funciona”, “no anda”, “no carga”, “error en el link”, “no me deja entrar”
  - Tras enviar link → NO repetir “¿Te lo mando?” ni mandar otro flujo de booking
  - 1er mensaje: IA empatía + tip (otro navegador / computadora) + repetir link si ayuda
  - Si insiste → derivación al equipo (IA o handoff)
- Sin turnos disponibles (NO confundir con fallo técnico):
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

## Precio consulta (prioridad sobre sede)
- “precio consulta en corrientes?”
  - Respuesta: preguntar obra social o dar plus si ya la dijo; **no** “¿En qué te puedo ayudar?”.
- Debe interceptarse antes que cualquier handler de selección de sede.

## Precio consulta + ciudad + obra social en un solo mensaje
- “Hola, soy de Formosa y tengo IOSCOR. ¿Cuánto sale la consulta?”
  - Respuesta: plus/cobertura de IOSCOR en Formosa (desde sheets), tono humano; **no** “¿En qué te puedo ayudar?”.
- Mismo criterio: “soy de Corrientes con OSDE, cuánto sale la consulta”, “de Resistencia tengo Sancor, precio de la consulta”.

## Disponibilidad / turno con día u hora (Corrientes o Resistencia)
- Tras hablar de Formosa (solo precio/derivación), usuario: “¿Tenés algo mañana a las 18?”
  - **No** derivar a Formosa; preguntar sede online (Corrientes/Resistencia) o usar sede ya elegida si es link.
- “bueno un turno para ctes mañana 17hs”
  - Respuesta: tono humano + **URL real** de agenda de Corrientes; **no** texto “[link de agenda]” ni placeholder.
  - Debe reconocer cambio de sede (ctes) aunque el contexto previo fuera Formosa.

## Sáenz Peña — follow-up de horario
- Tras derivación telefónica Sáenz Peña, usuario: “mañana 17hs”
  - Mantener contexto Sáenz Peña; repetir teléfono + aclarar que no se confirman horarios por chat.
  - **No** volver a preguntar Corrientes/Resistencia.

## Chaco → Sáenz Peña → turno (sin link de Resistencia)
- “Soy de Chaco. ¿Atiende cerca? Tengo OSDE, necesito test de alergia y espirometría.”
  - Preguntar Resistencia o Sáenz Peña.
- “Sáenz Peña”
  - Cobertura OSDE en Sáenz Peña; **no** ofrecer link de agenda.
- “para agendar turno?”
  - Derivación telefónica Sáenz Peña (`3644314019`); **no** volver a preguntar sede ni “Por acá no agendamos… ¿Para qué sede es?”.
  - **No** “link que ya te pasé” ni link de Resistencia/Corrientes.
  - Aunque el paciente tenga un link viejo de Resistencia en sesión, la sede activa es Sáenz Peña.

## Formosa / Sáenz Peña (solo derivación telefónica, sin link)
- “Soy de Sáenz Peña y quiero atenderme la semana que viene.”
  - Respuesta: teléfono de la sede (`3644314019`); **no** ofrecer link ni “coordinar cita por acá”.
- Tras esa respuesta: “sí”
  - Respuesta: repetir derivación telefónica; **no** “link que ya te pasé”.
- Mismo criterio para Formosa (`3705098000`).
- Si hubo link de Corrientes/Resistencia hace más de 1 h, no recordarlo al hablar de Formosa/Sáenz Peña.

## Contexto de obra social — no volver a preguntar
- “Soy de Formosa, tengo Swiss Medical, necesito espirometría… ¿cuánto sale?” → derivación telefónica Formosa.
- Follow-up: “pero me decís precio de consulta?”
  - **No** “¿qué obra social/prepaga tenés?”; usar Swiss Medical del mensaje anterior y responder plus/cobertura en Formosa.

## Confianza / enfoque del Dr. (no confundir con estudios)
- “Hace 15 años que me atiendo con alergistas… prick test, patch test… Nada funcionó. ¿El Dr. hace algo diferente?”
  - Respuesta empática sobre experiencia y enfoque del Dr.; **no** “realiza test de alergia en Formosa” ni pedir obra social.

## Mensaje rico (precio total + estudio + turno + disponibilidad)
- “Soy de Corrientes, tengo IOSCOR, quiero turno… prick test, ¿cuánto me sale todo? ¿Hay algo libre el lunes después de las 17?”
  - Total aproximado (plus + estudio según reglas), tono humano con IA, y orientación sobre agenda para disponibilidad; **no** solo una línea de plus.

## Formosa / Sáenz Peña — mensaje rico (estudio + Sancor + qué conviene)
- “Soy de Formosa. No sé si usar mi obra social o pagar particular. Tengo Sancor. Quiero hacerme un prick test… ¿Qué me conviene?”
  - **Varios mensajes** (humanizados con IA), en este orden:
    1. Sí, el Dr. realiza el test de alergia en Formosa + evaluación previa.
    2. Cobertura/plus de Sancor en Formosa (desde sheets).
    3. Orientación obra social vs particular según el caso.
    4. Teléfono `3705098000` para turnos en Formosa.
  - **No** solo el teléfono en un único mensaje.

## Estudios — typos con IA y política de precios
- “¿Cuánto sale la eperitometria?” / “espirimetria” / typos similares
  - IA detecta espirometría; si es **solo** el estudio: **$40.000** (particular / sin consulta en Corrientes).
  - Si menciona control/seguimiento de asma: aclarar que puede haber otro valor en clínica.
- “¿Cuánto sale el prick test?” / “test de alergia” (sin turno ni consulta en el mismo mensaje)
  - **No** dar precio fijo; indicar que hay distintos tipos (medicamentos, alimentos, aeroalérgenos) y que primero va **consulta de evaluación**.
- Tras charla de agenda/link, usuario: **“Hacen test”** / “¿Hacen tests?” / “¿Realizan estudios?”
  - **No** responder con “no puedo agendar por vos con el link”.
  - Sí: confirma que el Dr. realiza tests de alergia, espirometría y otros según el caso (con sede si está en contexto).
  - Aclara: tests de alergia **sin valor fijo** por chat → primero **consulta de evaluación** (no siempre hace falta test).
  - Espirometría sola: sí tiene valor particular conocido si lo piden después.
- “Soy de Corrientes, IOSCOR, turno + prick test, ¿cuánto me sale todo?”
  - Sigue el flujo de **costo total** (plus + estudio según reglas), no solo plus ni precio fijo de alergia.

## Anti-bucle Sáenz Peña — no quedar “tildado”
- Tras contexto viejo o respuesta errónea de Sáenz Peña, usuario: **“Hacen test?”** / **“HACEM TEST?”** / **“Soy de corrientes”** / **“No soy de tesis”**
  - **No** repetir siempre el teléfono `3644314019`.
  - “Hacen/Hacem test” → estudios + consulta previa (sin precio fijo de alergia).
  - “Soy de corrientes” → confirmar Corrientes y limpiar sede referral vieja.
  - “No soy de tesis/resistencia” → pedir disculpas y repreguntar ciudad.

## Sede / sucursal — presencia en una ciudad
- “Hola, ¿me podés decir si tiene sucursal en Corrientes?” / “¿Atiende en Corrientes?”
  - **Sí**: confirmar que el Dr. atiende en Corrientes y ofrecer ayuda (`¿En qué te puedo ayudar?`).
  - **No** responder solo con teléfono de Sáenz Peña ni mezclar sedes por contexto viejo de otra charla.

## Link de agenda — pedido explícito y reenvío
- Tras charla de ayer (o más de 1 h sin link en el chat), usuario: **“Me podés pasar el link”** / “No tengo el link, mandamelo nuevamente”
  - **Sí** enviar la URL completa de la agenda (Corrientes/Resistencia según sede en contexto).
  - **No** responder solo “con el link que ya te pasé” sin pegar el link.
- **“Me podés pasar el link para los turnos”** / **“Me podés pasar link nuevamente”** (con sede Corrientes en contexto)
  - **Sí** pegar la URL de agenda de Corrientes.
  - **No** humanizar a “con el link que ya te compartí…” sin URL.
- Si el link se envió hace menos de 1 h y el usuario no lo pide de nuevo, puede usarse recordatorio corto sin repetir la URL.

## Link de agenda — no repetir en la misma hora
- Tras enviar link de Resistencia (p. ej. confirmación de consulta virtual), usuario: “martes 10am”
  - Respuesta: recordatorio corto (“Perfecto, el martes… Con el link que ya te pasé…”); **no** volver a pegar la URL ni “Cualquier duda que te surja, avisame.”
- Mismo criterio si el usuario pide otro día/hora dentro de la hora siguiente al último link enviado para esa sede.
- Pasada 1 h desde el último envío, puede volver a mandarse el link completo si el flujo lo requiere.

## Robustez producción
- Deduplicación por `message.id` (evitar dobles respuestas por reintentos)
- Staleness: ignorar mensajes muy viejos o fuera de orden (timestamp vs `lastInboundMessageAtMs`)
- Rate limiting por usuario: cooldown corto para mensajes de bajo signal (evitar spam)

## Obra social institucional desconocida (Banco Nación) + varias preguntas
- “Soy de Corrientes y tengo la obra social del Banco Nación. ¿Atienden? ¿Hay plus? ¿Cuánto cuesta la consulta y el test de alergia?”
  - **No** responder solo “Sí, el Dr. atiende en Corrientes. ¿En qué te puedo ayudar?”.
  - **No** fuzzy-matchear otra OS del sheet ni inventar plus.
  - **No** repetir dos mensajes casi iguales para “¿Atienden?” y “¿Hay plus?”; un solo mensaje de derivación que cubra aceptación y plus.
  - **Sí** (máximo 2 mensajes): (1) derivación consultorio por cobertura/plus no cargada, (2) precio particular consulta + test de alergia requiere evaluación.

## Emergencia aguda (empeoramiento reciente + respirar/garganta)
- “Hace dos horas me puse peor, me cuesta respirar y tengo la garganta rara. ¿Turno urgente para hoy?”
  - **Sí** derivar directo a guardia/107 en el primer mensaje (sin preguntar “¿urgencia o turno?”).
  - Si el paciente ya confirmó urgencia, **no** repetir la misma derivación en otro mensaje.

## Pediatría + dermatitis + IOSCOR + test + total (no mezclar FAQ inventada)
- “Hola, es para mi hija de 4 años. Somos de Corrientes. Tiene dermatitis desde bebé, IOSCOR nos cubre. ¿Atiende niños? ¿Hace test de alergia? ¿Cuánto sale todo junto?”
  - **No** responder orden de consulta, medios de pago ni autorización si no los preguntó.
  - **Sí**: pediatría + dermatitis + test de alergia + cobertura IOSCOR + orientación de costo total (evaluación previa para alergia).

## Mensaje rico con ciudad (no debe quedarse solo en sede)
- “Hola, soy de Resistencia, tengo Swiss Medical, hace 8 años congestionado… neumonólogo pidió espirometría. ¿La hacen? ¿Cuánto me saldría en total con la consulta? ¿Tengo que ir en ayunas?”
  - **No** responder solo “Sí, el Dr. atiende en Resistencia. ¿En qué te puedo ayudar?”.
  - **Sí**: empatía por síntomas crónicos + confirma espirometría + cobertura Swiss + total aproximado + preparación (sin inventar ayunas).
  - El handler de declaración de ciudad (`tryHandleSedeCityDeclaration`) debe ceder si el mensaje tiene varias preguntas o temas clínicos/administrativos.

## Memoria de conversación — reinicio por inactividad
- Usuario eligió sede/OS ayer y hoy escribe de nuevo (sin mensajes en **4 h** por defecto)
  - El estado guardado (sede, link, obra social, etc.) se **borra**; la charla arranca de cero con saludo si corresponde.
- Usuario mantiene charla activa cada pocas horas pero lleva más de **24 h** desde el primer mensaje de la sesión
  - También se reinicia (tope máximo de sesión), aunque haya actividad reciente.
- Variables de entorno (opcionales): `CONVERSATION_INACTIVITY_RESET_HOURS` (default 4), `CONVERSATION_MAX_AGE_HOURS` (default 24), `CONVERSATION_STATE_TTL_SECONDS` (TTL en Redis; default alineado a inactividad).

