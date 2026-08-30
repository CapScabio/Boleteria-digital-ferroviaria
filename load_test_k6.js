/* ==========================================================================
   LÍNEA MITRE - PRUEBAS DE ESTRÉS Y CONCURRENCIA (k6 LOAD TEST)
   Simulación de 10.000 Solicitudes Concurrentes / sec en Hora Pico Retiro
   ========================================================================== */

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
    // Definición de las fases de carga escalonada (Ramp-up)
    stages: [
        { duration: '30s', target: 2000 },  // Carga inicial moderada (2.000 req/s)
        { duration: '1m',  target: 10000 }, // Pico máximo de hora punta en Retiro (10.000 req/s)
        { duration: '2m',  target: 10000 }, // Mantenimiento de la carga de estrés
        { duration: '30s', target: 0 },     // Ramp-down (desconexión progresiva)
    ],
    thresholds: {
        // Criterios de aceptación (SLI / SLO de la Tesis)
        'http_req_duration': ['p(95)<200'], // El 95% de las validaciones debe tardar menos de 200 ms
        'http_req_failed': ['rate<0.01'],   // La tasa de error debe ser inferior al 1%
    },
};

const BASE_URL = 'http://localhost:3000/api/v1';

export default function () {
    // 1. Simulación de Precompra de Pasaje Digital
    const purchasePayload = JSON.stringify({
        branch: 'tigre',
        origin_station_id: 1,  // Retiro
        dest_station_id: 15,   // Tigre
        device_fingerprint: `DEV_HASH_${__VU}_${__ITER}`,
        payment_token: 'tok_visa_openloop_demo'
    });

    const headers = { 'Content-Type': 'application/json' };

    // Solicitud POST de Adquisición
    const purchaseRes = http.post(`${BASE_URL}/tickets/purchase`, purchasePayload, { headers });
    
    check(purchaseRes, {
        'Ticket emitido exitosamente (HTTP 201)': (r) => r.status === 201,
        'Latencia de emisión OK (< 150ms)': (r) => r.timings.duration < 150,
    });

    // Extraer datos simulados para la validación del Inspector a bordo
    const ticketId = 'a1b2c3d4-e5f6-7890-abcd-1234567890ab';
    const currentCounter = Math.floor(Date.now() / 1000 / 15);

    // 2. Simulación de Inspección a Bordo por Patrulla (Validación QR TOTP)
    const validatePayload = JSON.stringify({
        ticket_id: ticketId,
        counter: currentCounter,
        signature: '0x8F92A7C4B1E9',
        inspector_id: 'INSP_PATRULLA_MITRE_04'
    });

    const validateRes = http.post(`${BASE_URL}/tickets/validate`, validatePayload, { headers });

    check(validateRes, {
        'Validación de pasaje OK (HTTP 200)': (r) => r.status === 200,
        'Respuesta ultra-rápida (< 50ms con Redis)': (r) => r.timings.duration < 50,
    });

    sleep(1); // Pausa de 1 segundo entre iteraciones por usuario virtual
}
