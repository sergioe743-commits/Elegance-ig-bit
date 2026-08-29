// Heuristica de seguridad: decide si un mensaje entrante NO debe recibir una
// respuesta automatica de contenido, sino escalarse a revision humana con un
// mensaje de espera neutro. Es intencionadamente amplia ("mejor escalar de
// mas") porque el coste de una respuesta medica automatica incorrecta es
// mucho mayor que el de una respuesta manual con algo de retraso.

const RED_FLAG_PATTERNS = [
    // Urgencias / sintomas agudos
    /urgen(te|cia)/i,
    /sangr(a|o|ando|amiento)/i,
    /infecci[oó]n/i,
    /fiebre/i,
    /muchísimo dolor|dolor (fuerte|intenso|insoportable)/i,
    /hinchaz[oó]n (fuerte|excesiva)/i,
    /reacci[oó]n al[eé]rgica|al[eé]rgi[ca]/i,
    /no puedo (respirar|mover)/i,
    /urgencias|hospital/i,

    // Estado de salud / embarazo / medicacion que requiere valoracion individual
    /embaraz/i,
    /lactancia/i,
    /anticoagulant/i,
    /medicaci[oó]n|tratamiento (m[eé]dico|con)/i,
    /enfermedad (autoinmune|cr[oó]nica)/i,
    /alergi/i,

    // Salud mental / autolesion, nunca auto-responder, siempre escalar
    /suicid/i,
    /autolesi/i,
    /hacerme da[nñ]o/i,
    /no quiero vivir/i,

    // Menores de edad
    /tengo\s*1[0-7]\s*a[nñ]os/i,
    /mi hij[oa].*(años|edad)/i,

    // Reclamaciones / insatisfaccion grave, mejor gestion humana directa
    /demanda|abogad|denuncia/i,
    /muy mal (resultado|experiencia)/i,
    /me ha (dejado|salido) fatal/i,
  ];

function needsHumanReview(text = "") {
    if (!text || typeof text !== "string") return false;
    return RED_FLAG_PATTERNS.some((re) => re.test(text));
}

// Heuristica simple para distinguir medico/profesional vs paciente potencial.
// No es perfecta: es una senal mas para el prompt, no una verdad absoluta.
const DOCTOR_SIGNALS = [
    /protocolo/i,
    /par[aá]metros/i,
    /ecograf[ií]a/i,
    /formaci[oó]n|mentor[ií]a|curso/i,
    /soy m[eé]dic[oa]/i,
    /compa[nñ]er[oa]/i,
    /reproducib/i,
    /t[eé]cnica (endolift|lipol[aá]ser)/i,
  ];

function detectAudience(text = "") {
    if (!text || typeof text !== "string") return "patient";
    return DOCTOR_SIGNALS.some((re) => re.test(text)) ? "doctor" : "patient";
}

module.exports = { needsHumanReview, detectAudience };
