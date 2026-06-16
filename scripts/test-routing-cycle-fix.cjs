const fs = require('fs');
const vm = require('vm');
const webhookPath = require('path').join(
  __dirname,
  '..',
  'netlify',
  'functions',
  'meta-whatsapp-webhook.cjs'
);
const source = fs.readFileSync(webhookPath, 'utf8');
const start = source.indexOf('function normalizeForMatch');
const end = source.indexOf('exports.handler');
const context = { console };
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

const testMessages = [
  '¿Cuánto sale solo la espirometría sin consulta?',
  '¿La consulta incluye estudios y cuánto sale el turno?',
  '¿Cuánto sale la espirometría sin consulta y atienden OSDE?',
  'quiero agendar turno',
  'cuanto sale la consulta particular',
  'x'.repeat(15000) + ' espirometria sin consulta cuanto sale',
];

const functionsToTest = [
  'messageLooksLikeSpirometryOnlyInquiry',
  'messageLooksLikeMultiQuestionPatientInquiry',
  'messageLooksLikePrivatePriceQuestion',
  'messageLooksLikeBookingIntent',
  'messageHasMultipleDistinctQuestionSignals',
  'messageMentionsSpirometryStudy',
];

let failed = 0;
for (const functionName of functionsToTest) {
  const detectFunction = context[functionName];
  if (typeof detectFunction !== 'function') {
    console.error('Missing function:', functionName);
    failed += 1;
    continue;
  }
  for (const message of testMessages) {
    try {
      const result = detectFunction(message);
      console.log(functionName, JSON.stringify(message.slice(0, 55)), '=>', result);
    } catch (error) {
      console.error('FAIL', functionName, message.slice(0, 55), error.message);
      failed += 1;
    }
  }
}

process.exit(failed > 0 ? 1 : 0);
