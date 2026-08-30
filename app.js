/* ==========================================================================
   LÍNEA MITRE - SISTEMA DE BOLETAJE DIGITAL PREPAGO (AFC OPEN-LOOP)
   Application Logic & Cryptographic TOTP Engine
   (GPS Telemetry, Multi-Trip Tokens, Round-Trip & Partial Refunds)
   ========================================================================== */

// 1. DATA: STATIONS & FARES FOR LÍNEA MITRE BRANCHES
const BRANCHES_DATA = {
    tigre: {
        name: "Retiro - Tigre (Ramal Eléctrico)",
        stations: [
            { name: "Retiro", km: 0 },
            { name: "Lisandro de la Torre", km: 3 },
            { name: "Belgrano C", km: 5 },
            { name: "Núñez", km: 8 },
            { name: "Rivadavia", km: 10 },
            { name: "Vicente López", km: 11 },
            { name: "Olivos", km: 13 },
            { name: "La Lucila", km: 15 },
            { name: "Martínez", km: 17 },
            { name: "Acassuso", km: 19 },
            { name: "San Isidro C", km: 21 },
            { name: "Beccar", km: 23 },
            { name: "San Fernando C", km: 25 },
            { name: "Carupá", km: 27 },
            { name: "Tigre (Terminal)", km: 28 }
        ]
    },
    suarez: {
        name: "Retiro - José León Suárez",
        stations: [
            { name: "Retiro", km: 0 },
            { name: "Ministro Carranza", km: 5 },
            { name: "Miguelete", km: 12 },
            { name: "San Martín", km: 14 },
            { name: "San Andrés", km: 16 },
            { name: "Malaver", km: 18 },
            { name: "Villa Ballester", km: 20 },
            { name: "Chilavert", km: 22 },
            { name: "José León Suárez", km: 24 }
        ]
    },
    mitre: {
        name: "Retiro - Bartolomé Mitre",
        stations: [
            { name: "Retiro", km: 0 },
            { name: "Ministro Carranza", km: 5 },
            { name: "Colegiales", km: 7 },
            { name: "Belgrano R", km: 9 },
            { name: "Coghlan", km: 11 },
            { name: "Saavedra", km: 13 },
            { name: "Juan B. Justo", km: 15 },
            { name: "Florida", km: 17 },
            { name: "C.A. Coghlan", km: 19 },
            { name: "Bartolomé Mitre", km: 21 }
        ]
    }
};

const TICKET_TYPES_DATA = {
    single: { label: "BOLETO ÚNICO", trips: 1, discount: 0 },
    semanal: { label: "ABONO SEMANAL (10 Viajes)", trips: 10, discount: 0.10 },
    mensual: { label: "ABONO MENSUAL (40 Viajes)", trips: 40, discount: 0.25 },
    trimestral: { label: "ABONO TRIMESTRAL (120 Viajes)", trips: 120, discount: 0.40 },
    estudiantil: { label: "ABONO ESTUDIANTIL / UNIV.", trips: 999, discount: 0.50 }
};

// Simulated Real-Time GPS Train Telemetry Data
const GPS_FORMATIONS_DATA = [
    {
        id: "3021",
        branch: "Retiro - Tigre",
        speed: 52,
        nextStation: "San Isidro C",
        delayMinutes: 22,
        status: "DEMORADO",
        statusClass: "badge-yellow",
        coords: "-34.4721, -58.5132"
    },
    {
        id: "3045",
        branch: "Retiro - J.L. Suárez",
        speed: 0,
        nextStation: "San Martín",
        delayMinutes: 45,
        status: "CANCELADO",
        statusClass: "badge-red",
        coords: "-34.5711, -58.5381"
    },
    {
        id: "3088",
        branch: "Retiro - B. Mitre",
        speed: 64,
        nextStation: "Belgrano R",
        delayMinutes: 0,
        status: "A TIEMPO",
        statusClass: "badge-green",
        coords: "-34.5622, -58.4590"
    }
];

// Global Active State
let currentTicket = null;
let userTicketsList = [];
let totpInterval = null;
let qrCodeInstance = null;
let certQrInstance = null;
const TOTP_PERIOD = 15;
const DEVICE_FINGERPRINT = "MITRE_DEVICE_HASH_8F91A7";

// Helper: Safe UUID generation for Vercel/mobile compatibility
function safeUUID() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Initialize App
document.addEventListener("DOMContentLoaded", () => {
    initNavigationTabs();
    initPassengerForm();
    initGpsTelemetry();
    initRefundsAndCertificates();
    initInspectorControls();
    updateLiveWatermarkClock();
});

// --------------------------------------------------------------------------
// 2. NAVIGATION & TABS
// --------------------------------------------------------------------------
function initNavigationTabs() {
    const navButtons = document.querySelectorAll(".nav-btn");
    const tabPanels = document.querySelectorAll(".tab-panel");

    navButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            navButtons.forEach(b => b.classList.remove("active"));
            tabPanels.forEach(p => p.classList.remove("active"));

            btn.classList.add("active");
            const targetTab = btn.getAttribute("data-tab");
            document.getElementById(targetTab).classList.add("active");
        });
    });
}

// --------------------------------------------------------------------------
// 3. PASSENGER FORM & FARE CALCULATOR (IDA Y VUELTA & ABONOS)
// --------------------------------------------------------------------------
function initPassengerForm() {
    const ticketTypeSelect = document.getElementById("ticket-type-select");
    const roundtripToggle = document.getElementById("roundtrip-toggle");
    const branchSelect = document.getElementById("branch-select");
    const originSelect = document.getElementById("origin-select");
    const destSelect = document.getElementById("dest-select");
    const form = document.getElementById("ticket-form");
    const btnConsumeTrip = document.getElementById("btn-consume-trip");

    function populateStations() {
        const branchKey = branchSelect.value;
        const stations = BRANCHES_DATA[branchKey].stations;

        originSelect.innerHTML = "";
        destSelect.innerHTML = "";

        stations.forEach((st) => {
            const opt1 = document.createElement("option");
            opt1.value = st.km;
            opt1.textContent = st.name;
            originSelect.appendChild(opt1);

            const opt2 = document.createElement("option");
            opt2.value = st.km;
            opt2.textContent = st.name;
            destSelect.appendChild(opt2);
        });

        destSelect.selectedIndex = stations.length - 1;
        calculateFare();
    }

    function calculateFare() {
        const origKm = parseInt(originSelect.value, 10);
        const destKm = parseInt(destSelect.value, 10);
        const distKm = Math.abs(destKm - origKm);

        let singleFare = 320.00;
        let section = 1;

        if (distKm > 12 && distKm <= 24) {
            singleFare = 400.00;
            section = 2;
        } else if (distKm > 24) {
            singleFare = 480.00;
            section = 3;
        }

        const isRoundTrip = roundtripToggle.checked;
        const multiplier = isRoundTrip ? 2 : 1;

        const modeKey = ticketTypeSelect.value;
        const modeData = TICKET_TYPES_DATA[modeKey];
        
        let rawTotal = singleFare * modeData.trips * multiplier;
        if (modeKey === 'estudiantil') rawTotal = singleFare * 30 * multiplier;

        const discountPct = modeData.discount;
        const finalAmount = rawTotal * (1 - discountPct);

        document.getElementById("fare-dist").textContent = `${distKm} km (Sección ${section})`;
        document.getElementById("fare-trip-type").textContent = isRoundTrip ? "Ida y Vuelta (2 tramos combinados)" : "Solo Ida (1 tramo)";
        document.getElementById("fare-discount-label").textContent = `${(discountPct * 100)}% de ahorro por anticipado`;
        document.getElementById("fare-amount").textContent = `$${finalAmount.toFixed(2)} ARS`;
    }

    branchSelect.addEventListener("change", populateStations);
    originSelect.addEventListener("change", calculateFare);
    destSelect.addEventListener("change", calculateFare);
    ticketTypeSelect.addEventListener("change", calculateFare);
    roundtripToggle.addEventListener("change", calculateFare);

    populateStations();

    // Handle Form Submit
    form.addEventListener("submit", (e) => {
        e.preventDefault();

        const branchKey = branchSelect.value;
        const branchName = BRANCHES_DATA[branchKey].name;
        const origName = originSelect.options[originSelect.selectedIndex].text;
        const destName = destSelect.options[destSelect.selectedIndex].text;
        const modeKey = ticketTypeSelect.value;
        const modeData = TICKET_TYPES_DATA[modeKey];
        const isRoundTrip = roundtripToggle.checked;

        if (origName === destName) {
            alert("Seleccione una estación de destino diferente a la de origen.");
            return;
        }

        const fareText = document.getElementById("fare-amount").textContent;
        const totalTrips = isRoundTrip ? (modeData.trips === 999 ? 999 : modeData.trips * 2) : modeData.trips;

        currentTicket = {
            uuid: safeUUID(),
            typeKey: modeKey,
            typeLabel: `${modeData.label}${isRoundTrip ? ' (Ida y Vuelta)' : ''}`,
            isRoundTrip: isRoundTrip,
            totalTrips: totalTrips,
            remainingTrips: totalTrips,
            branchKey: branchKey,
            branchName: branchName,
            origin: origName,
            destination: destName,
            amountPaid: fareText,
            issueTimestamp: Date.now(),
            secretSeed: "K_MITRE_SECRET_" + Math.random().toString(36).substring(2, 10),
            state: "ACTIVE"
        };

        userTicketsList.push(currentTicket);
        updateRefundDropdown();
        renderActiveTicket();
    });

    // Handle Manual Trip Token Consumption (1 Trip Decrement)
    btnConsumeTrip.addEventListener("click", () => {
        if (!currentTicket || currentTicket.state !== "ACTIVE") {
            alert("No hay un abono activo para validar.");
            return;
        }

        if (currentTicket.remainingTrips === 999) {
            alert("Abono Estudiantil ilimitado validado exitosamente para este tramo.");
            updateTotpQR();
            return;
        }

        if (currentTicket.remainingTrips > 1) {
            currentTicket.remainingTrips -= 1;
            document.getElementById("ticket-balance-display").textContent = `${currentTicket.remainingTrips} / ${currentTicket.totalTrips} viajes restantes`;
            alert(`✅ Viaje validado con éxito. Te quedan ${currentTicket.remainingTrips} viajes en tu abono.`);
            updateTotpQR();
        } else if (currentTicket.remainingTrips === 1) {
            currentTicket.remainingTrips = 0;
            currentTicket.state = "USED";
            document.getElementById("ticket-balance-display").textContent = `0 / ${currentTicket.totalTrips} viajes (AGOTADO)`;
            document.getElementById("ticket-status-badge").className = "badge badge-red";
            document.getElementById("ticket-status-badge").textContent = "AGOTADO";
            alert("✅ Último viaje validado. Tu abono ha sido completado.");
            updateTotpQR();
        } else {
            alert("El abono no posee más viajes disponibles.");
        }
    });
}

// --------------------------------------------------------------------------
// 4. TOTP ENGINE & DYNAMIC QR RENDER
// --------------------------------------------------------------------------
async function renderActiveTicket() {
    document.getElementById("no-ticket-view").classList.add("hidden");
    document.getElementById("active-ticket-view").classList.remove("hidden");

    document.getElementById("ticket-type-display").textContent = currentTicket.typeLabel;
    document.getElementById("ticket-orig-display").textContent = currentTicket.origin;
    document.getElementById("ticket-dest-display").textContent = currentTicket.destination;
    document.getElementById("ticket-route-arrow").textContent = currentTicket.isRoundTrip ? "⇄" : "➔";
    document.getElementById("ticket-branch-display").textContent = currentTicket.branchName;
    document.getElementById("ticket-uuid-display").textContent = currentTicket.uuid.substring(0, 13) + "...";
    
    const balanceStr = currentTicket.remainingTrips === 999 ? "Ilimitados (30 días)" : `${currentTicket.remainingTrips} / ${currentTicket.totalTrips} viajes restantes`;
    document.getElementById("ticket-balance-display").textContent = balanceStr;

    if (totpInterval) clearInterval(totpInterval);

    await updateTotpQR();
    totpInterval = setInterval(updateTotpQR, 1000);
}

async function updateTotpQR() {
    if (!currentTicket || currentTicket.state !== "ACTIVE") return;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const counter = Math.floor(nowSeconds / TOTP_PERIOD);
    const secondsRemaining = TOTP_PERIOD - (nowSeconds % TOTP_PERIOD);

    const payloadRaw = `${currentTicket.uuid}|${currentTicket.remainingTrips}|${counter}|${DEVICE_FINGERPRINT}`;
    const signature = await generateSHA256(payloadRaw + currentTicket.secretSeed);
    const shortSignature = signature.substring(0, 16);

    const qrPayload = JSON.stringify({
        t: currentTicket.uuid,
        rem: currentTicket.remainingTrips,
        c: counter,
        sig: shortSignature,
        dev: DEVICE_FINGERPRINT
    });

    document.getElementById("ticket-hash-display").textContent = `0x${shortSignature}`;
    document.getElementById("timer-countdown").textContent = `${secondsRemaining}s`;

    const progressPct = (secondsRemaining / TOTP_PERIOD) * 100;
    document.getElementById("timer-progress").style.width = `${progressPct}%`;

    const qrContainer = document.getElementById("qrcode-container");
    qrContainer.innerHTML = "";

    if (typeof QRCode !== "undefined") {
        try {
            qrCodeInstance = new QRCode(qrContainer, {
                text: qrPayload,
                width: 180,
                height: 180,
                colorDark: "#0d1117",
                colorLight: "#ffffff",
                correctLevel: QRCode.CorrectLevel.M
            });
        } catch (e) {
            renderFallbackQR(qrContainer, shortSignature);
        }
    } else {
        renderFallbackQR(qrContainer, shortSignature);
    }
}

function renderFallbackQR(container, signature) {
    container.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; justify-center:center; width:180px; height:180px; background:#0d1117; color:#38bdf8; border-radius:12px; border:2px solid #2f81f7; padding:12px; box-sizing:border-box; text-align:center;">
            <div style="font-size:2rem; margin-bottom:4px;">📱</div>
            <div style="font-size:0.75rem; font-weight:bold; color:#fff;">TOKEN TOTP QR</div>
            <div style="font-size:0.65rem; font-family:monospace; margin-top:6px; background:rgba(47,129,247,0.2); padding:4px 8px; border-radius:4px;">0x${signature}</div>
            <div style="font-size:0.6rem; color:#8b949e; margin-top:auto;">VÁLIDO EN PATRULLA</div>
        </div>
    `;
}

// --------------------------------------------------------------------------
// 5. GPS TRAIN TELEMETRY MODULE
// --------------------------------------------------------------------------
function initGpsTelemetry() {
    const container = document.getElementById("gps-trains-container");
    if (!container) return;

    container.innerHTML = "";
    GPS_FORMATIONS_DATA.forEach(train => {
        const card = document.createElement("div");
        card.className = "gps-train-card";
        card.innerHTML = `
            <div class="train-id-name">
                <span>🚆 Formación #${train.id}</span>
                <span class="badge ${train.statusClass}">${train.status}</span>
            </div>
            <div class="train-loc-info">
                <span>Ramal:</span> <strong>${train.branch}</strong><br>
                <span>Próxima Estación:</span> <strong>${train.nextStation}</strong>
            </div>
            <div class="train-speed-badge">
                Velocidad GPS: ${train.speed} km/h<br>
                <small style="font-size:0.65rem; color:#8b949e;">${train.coords}</small>
            </div>
            <div style="text-align:right;">
                <button class="btn btn-warning" onclick="selectGpsTrainRefund('${train.id}', '${train.delayMinutes}')" style="font-size:0.75rem; padding:0.4rem 0.8rem;">
                    ⚠️ Solicitar Devolución Viaje
                </button>
            </div>
        `;
        container.appendChild(card);
    });
}

function selectGpsTrainRefund(trainId, delayMins) {
    const tabBtn = document.querySelector('[data-tab="refunds-tab"]');
    if (tabBtn) tabBtn.click();

    const formSelect = document.getElementById("refund-formation-select");
    if (formSelect) formSelect.value = trainId;

    const delayCertSelect = document.getElementById("cert-delay-minutes");
    if (delayCertSelect) delayCertSelect.value = delayMins;
}

// --------------------------------------------------------------------------
// 6. REFUNDS (1 TRIP RESTITUTION) & OFFICIAL CERTIFICATE GENERATOR
// --------------------------------------------------------------------------
function initRefundsAndCertificates() {
    const refundForm = document.getElementById("refund-form");
    const btnGenerateCert = document.getElementById("btn-generate-cert");

    refundForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const ticketSelect = document.getElementById("refund-ticket-select");
        const formationSelect = document.getElementById("refund-formation-select");
        const ticketUuid = ticketSelect.value;

        if (!ticketUuid) {
            alert("No hay un pasaje o abono activo seleccionado para reembolsar.");
            return;
        }

        const targetTicket = userTicketsList.find(t => t.uuid === ticketUuid);
        if (targetTicket) {
            if (targetTicket.remainingTrips !== 999) {
                targetTicket.remainingTrips += 1; // Restores 1 trip credit to the active pass
            }
            targetTicket.state = "ACTIVE";
            
            if (currentTicket && currentTicket.uuid === targetTicket.uuid) {
                renderActiveTicket();
            }
        }

        const refundBox = document.getElementById("refund-status-box");
        document.getElementById("refund-status-text").textContent = `Se ha restituido exitosamente 1 crédito de viaje a tu abono por la afectación verificada en la Formación #${formationSelect.value}.`;
        refundBox.classList.remove("hidden");

        const kpiRefunds = document.getElementById("kpi-refunds-count");
        kpiRefunds.textContent = parseInt(kpiRefunds.textContent, 10) + 1;

        updateRefundDropdown();
    });

    btnGenerateCert.addEventListener("click", () => {
        const pName = document.getElementById("cert-passenger-name").value.trim() || "Santiago Nehuen Andrade Messali";
        const pDni = document.getElementById("cert-passenger-dni").value.trim() || "38.912.401";
        const delayVal = document.getElementById("cert-delay-minutes").value;

        document.getElementById("cert-out-name").textContent = pName;
        document.getElementById("cert-out-dni").textContent = pDni;

        if (currentTicket) {
            document.getElementById("cert-out-branch").textContent = currentTicket.branchName;
            document.getElementById("cert-out-route").textContent = `${currentTicket.origin} ${currentTicket.isRoundTrip ? '⇄' : '➔'} ${currentTicket.destination}`;
        }

        const d = new Date();
        document.getElementById("cert-out-datetime").textContent = `${d.toLocaleDateString()} ${d.toLocaleTimeString()} hs`;

        if (delayVal === "cancelled") {
            document.getElementById("cert-out-status").textContent = "FORMACIÓN CANCELADA (SIN SERVICIO)";
        } else {
            document.getElementById("cert-out-status").textContent = `DEMORA GPS REGISTRADA DE ${delayVal} MINUTOS (FORMACIÓN #3021)`;
        }

        const hashCert = "SHA256-SOFSE-" + Math.random().toString(36).substring(2, 8).toUpperCase();
        document.getElementById("cert-hash-code").textContent = `Hash: ${hashCert}`;

        const certQrBox = document.getElementById("cert-qr-container");
        certQrBox.innerHTML = "";
        if (typeof QRCode !== "undefined") {
            try {
                certQrInstance = new QRCode(certQrBox, {
                    text: `https://argentina.gob.ar/validador-mitre?cert=${hashCert}&dni=${pDni}`,
                    width: 70,
                    height: 70,
                    colorDark: "#1f6beb",
                    colorLight: "#ffffff",
                    correctLevel: QRCode.CorrectLevel.L
                });
            } catch (e) {
                certQrBox.innerHTML = `<div style="font-size:0.6rem; font-family:monospace; color:#1f6beb; text-align:center;">QR VERIFICADO</div>`;
            }
        } else {
            certQrBox.innerHTML = `<div style="font-size:0.6rem; font-family:monospace; color:#1f6beb; text-align:center;">QR VERIFICADO</div>`;
        }

        document.getElementById("printable-certificate-box").classList.remove("hidden");
    });
}

function updateRefundDropdown() {
    const refundSelect = document.getElementById("refund-ticket-select");
    refundSelect.innerHTML = "";

    const activeTickets = userTicketsList.filter(t => t.remainingTrips > 0 || t.remainingTrips === 999);

    if (activeTickets.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "-- No hay pasajes activos para solicitar reembolso --";
        refundSelect.appendChild(opt);
    } else {
        activeTickets.forEach(t => {
            const opt = document.createElement("option");
            opt.value = t.uuid;
            opt.textContent = `${t.typeLabel} - ${t.origin} ➔ ${t.destination} (Saldo: ${t.remainingTrips} viajes)`;
            refundSelect.appendChild(opt);
        });
    }
}

// SHA256 Web Crypto Helper with fallback
async function generateSHA256(str) {
    if (typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.digest) {
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(str);
            const hashBuffer = await crypto.subtle.digest("SHA-256", data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
        } catch (e) {
            // Fallback Hash
        }
    }
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16).padStart(16, "0");
}

function updateLiveWatermarkClock() {
    setInterval(() => {
        const d = new Date();
        const str = d.toTimeString().split(" ")[0] + "." + Math.floor(d.getMilliseconds() / 100);
        const el = document.getElementById("watermark-timer");
        if (el) el.textContent = str;
    }, 100);
}

// --------------------------------------------------------------------------
// 7. INSPECTOR SCANNER SIMULATOR
// --------------------------------------------------------------------------
function initInspectorControls() {
    const btnScanCurrent = document.getElementById("btn-scan-current");
    const btnScanExpired = document.getElementById("btn-scan-expired");
    const btnScanTampered = document.getElementById("btn-scan-tampered");

    btnScanCurrent.addEventListener("click", () => validateTicketScan("CURRENT"));
    btnScanExpired.addEventListener("click", () => validateTicketScan("EXPIRED"));
    btnScanTampered.addEventListener("click", () => validateTicketScan("TAMPERED"));
}

async function validateTicketScan(scenario) {
    const isOffline = document.getElementById("offline-mode-toggle").checked;
    const resultBox = document.getElementById("result-display-box");
    const resultIcon = document.getElementById("result-icon");
    const resultTitle = document.getElementById("result-title");
    const resultDetail = document.getElementById("result-detail");
    const resultBadge = document.getElementById("result-badge");
    const auditDetails = document.getElementById("audit-details");

    auditDetails.classList.remove("hidden");

    if (scenario === "CURRENT") {
        if (!currentTicket) {
            alert("No hay pasaje o abono activo generado. Primero adquiere uno en la pestaña de Comprar Pasaje.");
            return;
        }

        if (currentTicket.remainingTrips === 0) {
            resultBox.className = "result-display invalid";
            resultIcon.textContent = "🚫";
            resultTitle.textContent = "ABONO SIN SALDO / AGOTADO";
            resultDetail.textContent = "El abono no posee más viajes disponibles.";
            resultBadge.className = "badge badge-red";
            resultBadge.textContent = "AGOTADO / SIN SALDO";
            document.getElementById("audit-server-state").textContent = "INACTIVO (State: EXHAUSTED)";
            document.getElementById("audit-hmac-match").textContent = "N/A (Sin saldo)";
            document.getElementById("audit-time-skew").textContent = "N/A";
            document.getElementById("audit-mode").textContent = isOffline ? "LOCAL (CRYPTOGRAPHIC OFFLINE)" : "ONLINE (REDIS CLUSTER)";
            return;
        }

        resultBox.className = "result-display valid";
        resultIcon.textContent = "✅";
        resultTitle.textContent = "PASAJE / ABONO VÁLIDO";
        resultDetail.textContent = `Modalidad: ${currentTicket.typeLabel} | Saldo: ${currentTicket.remainingTrips} viajes | ${currentTicket.origin} ➔ ${currentTicket.destination} (${currentTicket.branchName})`;
        
        resultBadge.className = "badge badge-green";
        resultBadge.textContent = "VERIFICADO (PAGO OK)";

        document.getElementById("audit-server-state").textContent = `ACTIVO (Saldo: ${currentTicket.remainingTrips} viajes)`;
        document.getElementById("audit-hmac-match").textContent = "VERIFICADA OK (SHA256 Match)";
        document.getElementById("audit-time-skew").textContent = "Diferencia: 0s (Counter C±0)";
        document.getElementById("audit-mode").textContent = isOffline ? "LOCAL (CRYPTOGRAPHIC OFFLINE)" : "ONLINE (REDIS CLUSTER)";
    } 
    else if (scenario === "EXPIRED") {
        resultBox.className = "result-display expired";
        resultIcon.textContent = "⏳";
        resultTitle.textContent = "TOKEN EXPIRADO";
        resultDetail.textContent = "El código QR presentado tiene más de 15 segundos de antigüedad (captura atrasada).";
        
        resultBadge.className = "badge badge-yellow";
        resultBadge.textContent = "CÓDIGO EXPIRADO";

        document.getElementById("audit-server-state").textContent = "INACTIVO (State: EXPIRED)";
        document.getElementById("audit-hmac-match").textContent = "RECHAZADA (Counter Desfasado C-5)";
        document.getElementById("audit-time-skew").textContent = "Diferencia: +75s (> 15s limite)";
        document.getElementById("audit-mode").textContent = isOffline ? "LOCAL (CRYPTOGRAPHIC OFFLINE)" : "ONLINE (REDIS CLUSTER)";
    } 
    else if (scenario === "TAMPERED") {
        resultBox.className = "result-display invalid";
        resultIcon.textContent = "🚫";
        resultTitle.textContent = "ALERTA: FIRMA INVÁLIDA";
        resultDetail.textContent = "Posible intento de evasión tarifaria (Código QR alterado o reenviado desde otro dispositivo).";
        
        resultBadge.className = "badge badge-red";
        resultBadge.textContent = "INFRACCIÓN / EVASIÓN";

        document.getElementById("audit-server-state").textContent = "NO ENCONTRADO / ADULTERADO";
        document.getElementById("audit-hmac-match").textContent = "FALLÓ (Firma HMAC Mismatch)";
        document.getElementById("audit-time-skew").textContent = "N/A";
        document.getElementById("audit-mode").textContent = isOffline ? "LOCAL (CRYPTOGRAPHIC OFFLINE)" : "ONLINE (REDIS CLUSTER)";
    }
}
