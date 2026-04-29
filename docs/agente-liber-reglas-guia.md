# Agente Dr. Liber Acosta — Reglas (documento central informativo)

Este documento es la **fuente única de referencia** para entender el comportamiento del bot: reglas de negocio, caminos de conversación, edge cases y cómo se implementa hoy en este repo.

No es “código ejecutable”: el runtime real está en `netlify/functions/meta-whatsapp-webhook.cjs` y el prompt del LLM en `netlify/functions/agente-liber-system-prompt.txt`.

---

## Índice

- 1. Mapa de implementación (dónde vive cada regla)
- 2. Objetivo del bot (conversión + derivación)
- 3. Sedes (nombres, sinónimos, ambigüedades)
- 4. Datos y fuentes (links, obras sociales, precios)
- 5. Formato y estilo de mensajes (WhatsApp)
- 6. Estados de conversación (memoria por usuario)
- 7. Intents (qué detectamos y cómo se priorizan)
- 8. Caminos / casos principales (playbook)
- 9. Derivación a humano (criterios y mensajes)
- 10. Emergencias (hard rule)
- 11. Robustez en producción (dedupe, staleness, rate limiting)
- 12. QA (checklist de escenarios)

---

## 1. Mapa de implementación (dónde vive cada regla)

### 1.1 Prompt del LLM (solo guía de tono y límites)

- **Archivo activo**: `netlify/functions/agente-liber-system-prompt.txt`
- **Uso**: se envía como `role: system` cuando el webhook decide usar OpenAI.
- **Alcance**: identidad/tono, restricciones (“no diagnósticos”, “no inventar montos”), y flujo general.

### 1.2 Reglas determinísticas (código, no negociables)

- **Archivo**: `netlify/functions/meta-whatsapp-webhook.cjs`
- **Ejemplos**:
  - Detección de sede, typos y desambiguación “Chaco”.
  - Respuestas fijas para emergencias, no-text, privacidad, link trouble, “no hay turnos”, etc.
  - Gestión de estado por usuario (última sede, opt-out de link, cooldowns, dedupe).

### 1.3 Documentación técnica complementaria (informativa)

- `docs/openai-agent-basic-stateless.md`: arquitectura/explicación del diseño.
- `docs/whatsapp-bot-test-cases.md`: checklist de QA (escenarios reales).

---

## 2. Objetivo del bot (conversión + derivación)

- Objetivo principal: **ayudar a que el paciente reserve un turno** (sin inventar disponibilidad).
- Objetivo secundario: **derivar a secretaría/equipo** cuando:
  - el usuario no puede/ no quiere usar el link,
  - hay problemas técnicos,
  - no hay turnos,
  - solicita reprogramar/cancelar,
  - pide hablar con un humano,
  - hay conflictos/enojo,
  - o el caso requiere atención manual.

---

## 3. Sedes (nombres, sinónimos, ambigüedades)

Sedes válidas del Dr. Liber Acosta (únicamente estas):

- Corrientes capital
- Resistencia (Chaco)
- Formosa capital
- Sáenz Peña (Chaco)

Reglas informativas:

- “Chaco” sin ciudad específica es **ambiguo** → pedir “Resistencia o Sáenz Peña”.
- Se toleran typos comunes (ver QA) y abreviaturas habituales.

---

## 4. Datos y fuentes (links, obras sociales, precios)

### 4.1 Links de agenda

- Los links se inyectan por **código** (variables de entorno), el LLM **no** debe inventarlos.
- En este repo se usan variables tipo `CALENDLY_CORRIENTES`, `CALENDLY_RESISTENCIA`, etc.

### 4.2 Obras sociales / plus y precios

- Los montos **no se inventan**.
- La intención es abastecerlos desde Google Sheets (ver implementación actual en el webhook).
- Reglas vigentes para estudios:
  - Test de alergia: `$30.000` en todas las sedes.
  - Espirometría con consulta: `$30.000`.
  - Solo espirometría sin consulta: `$40.000`.
  - Consulta particular + estudio: precio de consulta de la sede + `$30.000`.
  - OSDE, Sancor e ISSUNNE: test/espirometría incluido en el valor de la consulta.

---

## 5. Formato y estilo de mensajes (WhatsApp)

Reglas informativas de estilo (la intención es que el bot “suene humano”):

- Texto plano (sin markdown).
- Máximo 1 emoji si suma (lista aprobada en el prompt).
- Respuestas cortas; si hay que dividir, que sea en mensajes separados (el webhook maneja delays).
- Validar antes de preguntar; responder lo que preguntaron antes de pedir lo que falta.
- Evitar frases “robot” (ver prompt).

---

## 6. Estados de conversación (memoria por usuario)

El bot mantiene estado por número para reducir repreguntas y manejar flujos.

### 6.1 Campos persistidos (implementación actual)

El state guarda (según el caso) estos campos (nombres reales, según el webhook):

- `state`: string con el “modo” actual (ver 6.2).
- Última sede detectada/confirmada:
  - `lastSedeEnvKey`
  - `lastSedeDisplayName`
  - `lastSedeOptionNumber`
  - `lastSedeAtMs`
- Dedupe / orden / robustez:
  - `recentInboundMessageIds`
  - `lastInboundMessageAtMs`
  - `lastSeenAtMs`
- Cooldowns / anti-spam:
  - `bookingLinkOptOutUntilMs`
  - `lastNonTextWriteItDownAtMs`
  - `lastNonTextMessageType`
  - `lastSensitiveDataWarningAtMs`
- Flujos específicos (según el caso):
  - `awaitingSedeSelectionAtMs`
  - `healthInsuranceName`
  - `healthInsuranceFamily`
  - `sedeEnvKey`, `sedeDisplayName`, `sedeOptionNumber`, `reason` (para `awaiting_link_confirmation`)

### 6.2 Estados (`state.state`) usados por el webhook

- `awaiting_link_confirmation`
- `awaiting_sede_selection`
- `awaiting_waitlist_confirmation`
- `awaiting_booking_link_trouble_followup`
- `awaiting_booking_link_sede`
- `awaiting_health_insurance_name`
- `awaiting_health_insurance_city`
- `awaiting_health_insurance_plan`
- `awaiting_private_price_city`
- `awaiting_schedule_sede`

### 6.3 Ventanas y cooldowns (valores actuales)

Estos valores están hardcodeados hoy:

- `DEFAULT_RESPONSE_DELAY_MS`: 3500
- `MESSAGE_COLLECTION_WINDOW_MS`: 6000
- `USER_REPLY_COOLDOWN_MS`: 6000
- `SMALL_TALK_COOLDOWN_MS`: 20000
- `BOOKING_LINK_OFFER_OPTOUT_MS`: 45 minutos
- `BOOKING_LINK_RECENTLY_SENT_MS`: 5 minutos
- `BOOKING_LINK_TROUBLE_FOLLOWUP_WINDOW_MS`: 10 minutos
- `WAITLIST_CONFIRMATION_WINDOW_MS`: 30 minutos
- `SEDE_SELECTION_WINDOW_MS`: 30 minutos
- `NON_TEXT_WRITE_IT_DOWN_COOLDOWN_MS`: 2 minutos
- `SENSITIVE_DATA_WARNING_COOLDOWN_MS`: 10 minutos
- `INBOUND_MESSAGE_DEDUPLICATION_TTL_MS`: 2 horas
- `INBOUND_MESSAGE_STALE_AFTER_MS`: 45 minutos

---

## 7. Intents (qué detectamos y cómo se priorizan)

Este apartado describe **qué cubrimos** y cómo se resuelve (hard rule vs flujo con estado vs fallback).

### 7.1 Detectores hard rule (nombres reales)

El webhook tiene detectores dedicados como:

- `messageLooksLikeGreetingOnly`
- `messageLooksLikeFarewell`
- `messageLooksLikeBookingIntent`
- `messageLooksLikeBookingLinkTrouble`
- `messageLooksLikeNoAvailability`
- `messageLooksLikeRealtimeAvailabilityQuestion`
- `messageAsksToBookWithoutLink`
- `messageAsksToRescheduleOrCancelBooking`
- `messageLooksLikeSedeSelectionConfusion`
- `messageLooksLikeVagueAnswer`
- `messageAsksAboutSedeAddressOrHowToArrive`
- `messageAsksForMapsLocation`
- `messageLooksLikeHealthInsurancePlusQuestion`
- `messageLooksLikeGenericInstitutionHealthInsurance`
- `messageAsksAboutCardiologicoHealthInsuranceInCorrientes`
- `messageSaysDoesNotKnowHealthInsurance`
- `messageLooksLikePrivatePriceQuestion`
- `messageAsksIfParticularIsAvailable`
- `messageAsksAboutStudiesOrTests`
- `messageAsksAboutStudyFasting`
- `messageAsksAboutStudyMedicationPreparation`
- `messageAsksAboutStudyDuration`
- `messageAsksAboutMedicationAllergyStudy`
- `messageAsksIfDoctorTreatsChildren`
- `messageAsksAboutConditionTreatment`
- `messageAsksAboutTreatmentCost`
- `messageAsksToTalkToDoctor`
- `messageAsksToTalkToSecretary`
- `messageLooksLikeSensitiveData`
- FAQs:
  - `messageAsksAboutDocumentationOrRequirements`
  - `messageAsksAboutReferralOrPrescription`
  - `messageAsksAboutInvoice`
  - `messageAsksAboutPaymentMethods`
  - `messageAsksAboutConsultDuration`
  - `messageAsksAboutCompanion`
  - `messageAsksAboutOtherProvinces`
  - `messageAsksAboutVirtualVisit`

### 7.2 Prioridad general (práctica)

1) Emergencias / seguridad
2) No-text / privacidad (warnings con cooldown)
3) Estados activos (confirmación de link / selección de sede / etc.)
4) Intents hard rule (maps, no hay turnos, link trouble, derivaciones, FAQs)
5) Router / multi-intent (cuando aplica)

---

## 8. Caminos / casos principales (playbook)

El playbook de casos está mantenido como checklist en:

- `docs/whatsapp-bot-test-cases.md`

### 8.1 Caminos principales (resumen práctico)

- Saludo solo:
  - Responder saludo humanizado y esperar intención (no disparar selección de sede de forma automática).
- Cierre natural del paciente:
  - Detectar despedidas/gracias y cerrar cálido sin reabrir la conversación con "¿te ayudo en algo más?".
- Saludo + intención (incluye multi-intent):
  - No tratarlo como “solo saludo”, procesar el contenido (p. ej. sede + OS + plus).
- Urgencia:
  - Si hay señales médicas críticas, responder guardia/107 inmediato.
  - Si es ambiguo ("urgente/emergencia"), desambiguar primero.
- Turno / agendar / link:
  - Si hay sede → link directo y patch de última sede.
  - Si falta sede → menú 1–4 y `awaiting_sede_selection`.
  - Oferta de link → `awaiting_link_confirmation`.
  - Rechazo del link → `bookingLinkOptOutUntilMs` para no insistir (salvo pedido explícito).
- Consulta de disponibilidad en tiempo real:
  - Explicar que días/horarios se ven en la agenda online.
  - Si hay sede conocida, enviar link directo; si falta sede, pedirla y continuar flujo.
- Link trouble:
  - Tip corto (otro navegador / computadora), luego `awaiting_booking_link_trouble_followup` si corresponde y derivación si persiste.
- No availability:
  - Respuesta específica por sede + opción de aviso/lista de espera → `awaiting_waitlist_confirmation`.
  - Si paciente acepta aviso: registrar confirmación y responder que le van a avisar (sin derivar automático).
- Obras sociales / plus:
  - Si falta OS → `awaiting_health_insurance_name`.
  - Si falta ciudad → `awaiting_health_insurance_city` con `healthInsuranceName`.
  - Si requiere plan (casos especiales) → `awaiting_health_insurance_plan`.
- Precio particular:
  - Si falta ciudad → `awaiting_private_price_city`.
- Horarios:
  - Si falta sede → `awaiting_schedule_sede`; si hay sede → respuesta con horarios.
- Ubicación / maps:
  - Dirección + “cómo llegar” + link de maps por sede.
- Estudios:
  - Info general + preparación; si preguntan precio de estudio, no mezclar con precio de consulta.
- No-text / privacidad:
  - Pedir que lo escriba (cooldown) y advertir no mandar datos sensibles (cooldown).

---

## 9. Derivación a humano (criterios y mensajes)

Reglas informativas:

- El token conceptual es `[DERIVAR]` (el webhook lo interpreta y envía un mensaje fijo al paciente).
- Mensaje al paciente al derivar (estilo): “Dejame pasarte con alguien del equipo que te puede ayudar mejor. En breve te contactan.”

---

## 10. Emergencias (hard rule)

Las emergencias deben resolverse **sin LLM**: detectar keywords normalizadas y responder guardia/107.

---

## 11. Robustez en producción (dedupe, staleness, rate limiting)

El webhook aplica medidas para evitar respuestas duplicadas y spam involuntario:

- Deduplicación por `message.id`.
- Ignorar mensajes viejos/fuera de orden (staleness).
- Cooldown por usuario para evitar múltiples respuestas por fragmentación.

---

## 12. QA (checklist de escenarios)

Lista de escenarios de prueba manual:

- `docs/whatsapp-bot-test-cases.md`
