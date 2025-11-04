// ================== CONFIG / GLOBALS ==================
// API URL with override helper
let API_URL = (localStorage.getItem("API_URL") || "http://localhost:5000/api").replace(/\/+$/, "");
window.setApiUrl = function(url) {
    if (!url) return;
    API_URL = url.replace(/\/+$/, "");
    localStorage.setItem("API_URL", API_URL);
    console.log("API_URL set to:", API_URL);
};

const token = localStorage.getItem("authToken");
if (!token) window.location.href = "index.html";

let isAdmin = false;

const PER_SEAT_PRICE = 100; // Fallback fare/seat
const OFFERS = [{
    code: "FIRST50",
    title: "50% OFF up to ₹100",
    desc: "For your first booking on RideSphere",
    percentage: 50,
    maxDiscount: 100,
    minAmount: 0,
    firstTimeOnly: true
}, {
    code: "BUS20",
    title: "20% OFF up to ₹80",
    desc: "Valid on any bus booking",
    percentage: 20,
    maxDiscount: 80,
    minAmount: 0
}, {
    code: "FLAT50",
    title: "Flat ₹50 OFF",
    desc: "Minimum payable ₹200",
    flat: 50,
    minAmount: 200
}, {
    code: "FEST100",
    title: "₹100 OFF",
    desc: "On orders above ₹300",
    flat: 100,
    minAmount: 300
}];

const routeMap = {}; // route_id -> route
const scheduleMap = {}; // schedule_id -> schedule
let bookingsCache = []; // latest bookings
let ratingsLocal = JSON.parse(localStorage.getItem("ridesphere_ratings") || "{}");
let selectedPromo = null;
let selectedStars = 0;
let ratingForBookingId = null;

// ================== NAV/UX ==================
const hamburger = document.getElementById("hamburger");
const navLinks = document.getElementById("navLinks");
hamburger.addEventListener("click", () => {
    navLinks.classList.toggle("active");
    hamburger.classList.toggle("active");
});

const darkToggle = document.getElementById("darkModeToggle");
if (localStorage.getItem("darkMode") === "true") document.body.classList.add("dark-mode");
darkToggle.addEventListener("click", () => {
    document.body.classList.toggle("dark-mode");
    localStorage.setItem("darkMode", document.body.classList.contains("dark-mode"));
    darkToggle.textContent = document.body.classList.contains("dark-mode") ? "☀️ " : "🌙 ";
});
darkToggle.textContent = document.body.classList.contains("dark-mode") ? "☀️" : "🌙 ";

document.getElementById("apiConfigBtn").addEventListener("click", () => {
    const newUrl = prompt("Set API base URL", API_URL);
    if (newUrl) {
        setApiUrl(newUrl);
        alert("API_URL set. Reloading…");
        location.reload();
    }
});

function logout() {
    localStorage.removeItem("authToken");
    localStorage.removeItem("is_admin");
    window.location.href = "index.html";
}

function showMessage(id, text, isError = false) {
    const elem = document.getElementById(id);
    if (!elem) return;
    elem.innerText = text;
    elem.className = isError ? "message error" : "message";
    setTimeout(() => {
        if (elem.innerText === text) elem.innerText = "";
    }, 4000);
}

// ================== NETWORK STATUS ==================
const netBanner = document.getElementById("netBanner");

function setNetStatus(online, once = false) {
    if (online) {
        netBanner.textContent = "Back online. Refreshing data…";
        netBanner.className = "net-banner online";
        if (!once) {
            setTimeout(() => {
                netBanner.style.display = "none";
            }, 2000);
        }
    } else {
        netBanner.textContent = "You are offline. Showing cached data if available.";
        netBanner.className = "net-banner offline";
        netBanner.style.display = "block";
    }
}
window.addEventListener("online", () => {
    setNetStatus(true);
    // Refresh data when back online
    loadRoutes().then(() => {
        loadSchedules().then(() => {
            loadBookingSchedules();
            loadMyBookings();
        });
    });
});
window.addEventListener("offline", () => setNetStatus(false));
if (!navigator.onLine) setNetStatus(false, true);

// ================== HELPERS ==================
function currency(n) {
    return "₹" + (Number(n || 0)).toFixed(0);
}

function isValidDate(d) {
    return d instanceof Date && !isNaN(d);
}

function getScheduleLabel(s) {
    if (!s) return "-";
    const d = new Date(s.departure);
    const time = isValidDate(d) ? d.toLocaleString() : s.departure;
    return `${s.bus_name} • ${time}`;
}

function getRouteLabelBySchedule(s) {
    if (!s) return "-";
    const r = routeMap[s.route_id];
    if (!r) return "-";
    return `${r.origin} → ${r.destination}`;
}

function getBookingStatus(b) {
    if (b.status) {
        const val = ("" + b.status).toLowerCase();
        if (["cancelled", "canceled"].includes(val)) return "Cancelled";
        if (["active", "booked", "confirmed"].includes(val)) return "Active";
    }
    if (b.is_cancelled === true || b.is_canceled === true) return "Cancelled";
    return "Active";
}

function badgeForStatus(status) {
    if (status === "Cancelled") return '<span class="badge badge-danger">Cancelled</span>';
    return '<span class="badge badge-success">Active</span>';
}

function hoursUntil(departureISO) {
    const d = new Date(departureISO);
    if (!isValidDate(d)) return null;
    const diffMs = d.getTime() - Date.now();
    return diffMs / (1000 * 60 * 60);
}

// Generic fetch with cache fallback
async function fetchJSONWithCache(url, options = {}, cacheKey, defaultValue) {
    try {
        const res = await fetch(url, options);
        if (!res.ok) {
            const text = await res.text().catch(() => res.statusText);
            throw new Error(`HTTP ${res.status}: ${text}`);
        }
        const data = await res.json().catch(() => {
            throw new Error("Invalid JSON");
        });
        if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify(data));
        return {
            data,
            fromCache: false
        };
    } catch (err) {
        console.warn(`Request failed for ${url}:`, err.message);
        const cached = cacheKey ? localStorage.getItem(cacheKey) : null;
        if (cached) {
            return {
                data: JSON.parse(cached),
                fromCache: true
            };
        }
        if (defaultValue !== undefined) return {
            data: defaultValue,
            fromCache: true
        };
        throw err;
    }
}

// Normalize API responses that may be arrays or objects with a key
function listFrom(payload, key) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload[key])) return payload[key];
    if (payload && payload.data && Array.isArray(payload.data[key])) return payload.data[key];
    if (payload && Array.isArray(payload.data)) return payload.data;
    return [];
}

// ================== OFFERS/Fare ==================
function renderOffers() {
    const grid = document.getElementById("offersGrid");
    grid.innerHTML = "";
    OFFERS.forEach(o => {
                grid.innerHTML += `
            <div class="offer-card">
                <div class="offer-title">${o.title}</div>
                <div class="offer-desc">${o.desc}${o.firstTimeOnly ? " • First-time only" : ""}${o.minAmount ? ` • Min: ₹${o.minAmount}` : ""}</div>
                <div><span class="offer-code">${o.code}</span></div>
                <div class="coupon-actions">
                    <button class="btn-secondary" onclick="copyCoupon('${o.code}')">Copy</button>
                    <button onclick="applyOfferFromCard('${o.code}')">Apply</button>
                </div>
            </div>
        `;
    });
}
function copyCoupon(code) {
    navigator.clipboard.writeText(code).then(() => {
        showMessage("promoMessage", `Coupon ${code} copied. Paste/apply in booking.`, false);
    });
}
function applyOfferFromCard(code) {
    const input = document.getElementById("promoCode");
    input.value = code;
    applyCoupon();
    document.location.hash = "#bookings";
}
function calculateDiscount(amount, code) {
    if (!code) return { discount: 0, reason: "No code applied" };
    const offer = OFFERS.find(o => o.code.toLowerCase() === code.toLowerCase());
    if (!offer) return { discount: 0, reason: "Invalid code" };
    const hasBookedOnce = localStorage.getItem("hasBookedOnce") === "true";
    if (offer.firstTimeOnly && hasBookedOnce) return { discount: 0, reason: "Code valid only for first booking" };
    if (offer.minAmount && amount < offer.minAmount) return { discount: 0, reason: `Min amount is ₹${offer.minAmount}` };
    let discount = 0;
    if (offer.percentage) {
        discount = Math.round(amount * (offer.percentage / 100));
        if (offer.maxDiscount) discount = Math.min(discount, offer.maxDiscount);
    } else if (offer.flat) {
        discount = offer.flat;
    }
    discount = Math.min(discount, amount);
    return { discount, reason: "Applied", offer };
}

// Seat map selection-aware fare
function getSelectedSeatCount() {
    return selectedSeats.length || (parseInt(document.getElementById("bookingSeats").value) || 0);
}
function updateFareSummary() {
    const seats = getSelectedSeatCount();
    const base = seats * PER_SEAT_PRICE;
    const promoCode = (document.getElementById("promoCode").value || "").trim();
    let discountObj = { discount: 0, reason: "No code", offer: null };
    if (promoCode) discountObj = calculateDiscount(base, promoCode);
    document.getElementById("fareBase").innerText = currency(base);
    document.getElementById("fareDiscount").innerText = "- " + currency(discountObj.discount);
    document.getElementById("fareTotal").innerText = currency(base - discountObj.discount);
    selectedPromo = discountObj.offer || null;
}
function applyCoupon() {
    const seatsVal = getSelectedSeatCount();
    const baseAmount = seatsVal * PER_SEAT_PRICE;
    const code = (document.getElementById("promoCode").value || "").trim();
    if (!code) return showMessage("promoMessage", "Enter a promo code to apply", true);
    const res = calculateDiscount(baseAmount, code);
    if (res.discount > 0) showMessage("promoMessage", `Coupon applied! You save ${currency(res.discount)}.`, false);
    else showMessage("promoMessage", res.reason || "Coupon not applicable", true);
    updateFareSummary();
}
function clearCoupon() {
    document.getElementById("promoCode").value = "";
    selectedPromo = null;
    showMessage("promoMessage", "Coupon cleared.", false);
    updateFareSummary();
}

// ================== API CALLS ==================
async function checkAdmin() {
    try {
        const res = await fetch(`${API_URL}/me`, { headers: { 'Authorization': 'Bearer ' + token } });
        const data = await res.json().catch(() => ({}));
        isAdmin = data.is_admin === true || data.is_admin === "true";
        document.getElementById("adminMenu").style.display = isAdmin ? "block" : "none";
        document.getElementById("admin").style.display = isAdmin ? "block" : "none";
    } catch (err) {
        console.warn("Admin check failed", err.message);
        document.getElementById("adminMenu").style.display = "none";
        document.getElementById("admin").style.display = "none";
    }
}

async function loadRoutes() {
    try {
        const { data, fromCache } = await fetchJSONWithCache(
            `${API_URL}/routes`,
            {},
            "cache_routes",
            { routes: [] }
        );
        const routes = listFrom(data, "routes");
        const tbody = document.querySelector("#routesTable tbody");
        const adminSelect = document.getElementById("adminRouteSelect");
        const status = document.getElementById("routesStatus");
        tbody.innerHTML = "";
        adminSelect.innerHTML = "";
        routes.forEach(r => {
            routeMap[r.id] = r;
            let action = "-";
            if (isAdmin) action = `<button onclick="updateRoute(${r.id})">Save</button> <button class="btn-danger" onclick="deleteRoute(${r.id})">Delete</button>`;
            tbody.innerHTML += `
                <tr id="route-${r.id}">
                    <td>${r.id}</td>
                    <td contenteditable="${isAdmin}">${r.name}</td>
                    <td contenteditable="${isAdmin}">${r.origin}</td>
                    <td contenteditable="${isAdmin}">${r.destination}</td>
                    <td>${action}</td>
                </tr>`;
            adminSelect.innerHTML += `<option value="${r.id}">${r.name} (${r.origin} → ${r.destination})</option>`;
        });
        status.textContent = fromCache ? "Showing cached routes (offline or API unavailable)" : "";
    } catch (err) {
        console.error("Routes load error:", err.message);
        document.getElementById("routesStatus").textContent = "Unable to load routes and no cache available.";
    }
}

async function loadSchedules() {
    try {
        const { data, fromCache } = await fetchJSONWithCache(
            `${API_URL}/schedules`,
            {},
            "cache_schedules",
            { schedules: [] }
        );
        const schedules = listFrom(data, "schedules");
        const tbody = document.querySelector("#schedulesTable tbody");
        const status = document.getElementById("schedulesStatus");
        tbody.innerHTML = "";
        schedules.forEach(s => {
            scheduleMap[s.id] = s;
            const routeLabel = routeMap[s.route_id] ? `${routeMap[s.route_id].name}` : s.route_id;
            let action = "-";
            if (isAdmin) action = `<button onclick="updateSchedule(${s.id})">Save</button> <button class="btn-danger" onclick="deleteSchedule(${s.id})">Delete</button>`;
            tbody.innerHTML += `
                <tr id="sched-${s.id}">
                    <td>${s.id}</td>
                    <td contenteditable="${isAdmin}">${routeLabel}</td>
                    <td contenteditable="${isAdmin}">${s.bus_name}</td>
                    <td contenteditable="${isAdmin}">${s.departure}</td>
                    <td contenteditable="${isAdmin}">${s.seats_available}</td>
                    <td>${action}</td>
                </tr>`;
        });
        status.textContent = fromCache ? "Showing cached schedules (offline or API unavailable)" : "";
    } catch (err) {
        console.error("Schedules load error:", err.message);
        document.getElementById("schedulesStatus").textContent = "Unable to load schedules and no cache available.";
    }
}

async function loadBookingSchedules() {
    try {
        const { data, fromCache } = await fetchJSONWithCache(
            `${API_URL}/schedules`,
            {},
            "cache_schedules",
            { schedules: [] }
        );
        const schedules = listFrom(data, "schedules");
        const select = document.getElementById("bookingScheduleSelect");
        select.innerHTML = "";
        schedules.forEach(s => {
            scheduleMap[s.id] = s;
            const r = routeMap[s.route_id];
            const label = r
                ? `${r.origin} → ${r.destination} | ${s.bus_name} | ${new Date(s.departure).toLocaleString()} | Seats:${s.seats_available}`
                : `ID:${s.id} | ${s.bus_name} | Seats:${s.seats_available}`;
            select.innerHTML += `<option value="${s.id}">${label}</option>`;
        });
        updateFareSummary();
        if (select.value) renderSeatMap(select.value);
        // No alert spam; rely on status banners if needed
    } catch (err) {
        console.error("Booking schedules load error:", err.message);
    }
}

async function loadMyBookings() {
    try {
        const { data, fromCache } = await fetchJSONWithCache(
            `${API_URL}/mybookings`,
            { headers: { 'Authorization': 'Bearer ' + token } },
            "cache_mybookings",
            { bookings: [] }
        );
        bookingsCache = listFrom(data, "bookings");
        document.getElementById("myBookingsStatus").textContent = fromCache ? "Showing cached bookings (offline or API unavailable)" : "";
        renderBookingsTable();
    } catch (err) {
        console.error("My bookings load error:", err.message);
        document.getElementById("myBookingsStatus").textContent = "Unable to load bookings and no cache available.";
        renderBookingsTable();
    }
}

// ================== RENDERERS ==================
function renderBookingsTable() {
    const tbody = document.querySelector("#bookingsTable tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    bookingsCache.forEach(b => {
        const sched = scheduleMap[b.schedule_id];
        const routeLabel = getRouteLabelBySchedule(sched);
        const schedLabel = getScheduleLabel(sched);
        const status = getBookingStatus(b);
        const hrs = sched ? hoursUntil(sched.departure) : null;
        const canCancel = status === "Active" && hrs !== null && hrs > 0;
        const canRate = sched && hrs !== null && hrs <= 0; // after departure
        const storedRating = ratingsLocal[b.id]?.rating || b.rating || 0;
        const stars = "★★★★★".split("").map((s, i) => i < storedRating ? "★" : "☆").join("");
        tbody.innerHTML += `
            <tr>
                <td>${b.id}</td>
                <td>${schedLabel}</td>
                <td>${routeLabel}</td>
                <td>${b.seats}</td>
                <td>${new Date(b.created_at).toLocaleString()}</td>
                <td>${badgeForStatus(status)}</td>
                <td>${status === "Active" ? `<button onclick="viewQR(${b.id})">View</button>` : "-"}</td>
                <td>
                    <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:center;">
                        <button class="btn-danger" ${canCancel ? "" : "disabled"} onclick="cancelBooking(${b.id}, ${b.schedule_id})">Cancel</button>
                        <button class="btn-secondary" ${canRate ? "" : "disabled"} onclick="openRating(${b.id})">Rate</button>
                    </div>
                </td>
                <td>${storedRating ? `<span title="${storedRating}/5">${stars}</span>` : "-"}</td>
            </tr>
        `;
    });
}

// ================== SEAT MAP ==================
let selectedSeats = [];
const SEAT_LAYOUT_CONFIG = {
    rows: 10,        // 10 rows of 2+2
    left: 2,
    right: 2,
    backRowSeats: 5, // 5-seat back bench
    frontRowsMark: 2,
    backRowsMark: 2
};

function seatLetterForIndex(idx, block) {
    const lettersLeft = ["A", "B", "C", "D", "E"];
    const lettersRight = ["C", "D", "E", "F", "G"]; // start at C for right block
    return block === "left" ? lettersLeft[idx] : lettersRight[idx];
}
function generateSeatLayout(cfg) {
    const seats = [];
    for (let r = 1; r <= cfg.rows; r++) {
        for (let i = 0; i < cfg.left; i++) {
            const label = `${r}${seatLetterForIndex(i, "left")}`;
            seats.push({ label, row: r, block: "left", pos: i });
        }
        seats.push({ label: `aisle-${r}`, isAisle: true });
        for (let j = 0; j < cfg.right; j++) {
            const label = `${r}${seatLetterForIndex(j, "right")}`;
            seats.push({ label, row: r, block: "right", pos: j });
        }
    }
    if (cfg.backRowSeats && cfg.backRowSeats > 0) {
        const br = cfg.rows + 1;
        for (let k = 0; k < cfg.backRowSeats; k++) {
            const label = `${br}${String.fromCharCode(65 + k)}`; // 11A..11E
            seats.push({ label, row: br, block: "back", pos: k, backRow: true });
        }
    }
    return seats;
}
function classifySeat(s, cfg) {
    if (s.isAisle) return { seatClass: "aisle" };
    const isFront = s.row <= cfg.frontRowsMark;
    const isBack = s.row > cfg.rows - cfg.backRowsMark || s.backRow === true;
    const isWindow =
        (s.block === "left" && s.pos === 0) ||
        (s.block === "right" && s.pos === cfg.right - 1) ||
        (s.backRow && (s.pos === 0 || s.pos === (cfg.backRowSeats - 1)));
    const isAisleSeat =
        (s.block === "left" && s.pos === cfg.left - 1) ||
        (s.block === "right" && s.pos === 0);
    const isMiddle = s.backRow && cfg.backRowSeats % 2 === 1 && s.pos === Math.floor(cfg.backRowSeats / 2);

    const classes = ["seat"];
    if (isWindow) classes.push("window");
    if (isAisleSeat) classes.push("aisle-seat");
    if (isMiddle) classes.push("middle");
    if (isFront) classes.push("front");
    if (isBack) classes.push("back");
    return { seatClass: classes.join(" "), isWindow, isAisleSeat, isMiddle, isFront, isBack };
}
async function fetchReservedSeats(scheduleId) {
    const headers = { 'Authorization': 'Bearer ' + (localStorage.getItem("authToken") || '') };
    const attempts = [
        `${API_URL}/schedules/${scheduleId}/seats`,
        `${API_URL}/schedule/${scheduleId}/seats`,
        `${API_URL}/seats?schedule_id=${scheduleId}`
    ];
    for (const url of attempts) {
        try {
            const r = await fetch(url, { headers });
            if (!r.ok) continue;
            const json = await r.json().catch(() => ({}));
            const arr = json.reserved || json.booked || json.seats || [];
            return (arr || []).map(x => String(x).toUpperCase());
        } catch (_) {}
    }
    return [];
}
function updateSeatSelectionUI() {
    const info = document.getElementById("seatSelectionInfo");
    const input = document.getElementById("bookingSeats");
    if (input) {
        input.value = selectedSeats.length || input.value || "";
        input.disabled = selectedSeats.length > 0; // allow manual input if none selected
    }
    if (info) {
        if (selectedSeats.length === 0) info.textContent = "No seats selected.";
        else info.textContent = `Selected: ${selectedSeats.join(", ")}`;
    }
    updateFareSummary();
}
function clearSeatSelection() {
    selectedSeats = [];
    document.querySelectorAll("#seatGrid .seat.selected").forEach(el => el.classList.remove("selected"));
    updateSeatSelectionUI();
}
async function renderSeatMap(scheduleId) {
    const grid = document.getElementById("seatGrid");
    if (!grid) return;
    selectedSeats = [];
    grid.innerHTML = "";

    const skeleton = document.createElement("div");
    skeleton.className = "muted";
    skeleton.style.gridColumn = "1 / -1";
    skeleton.style.textAlign = "center";
    skeleton.textContent = "Loading seat map…";
    grid.appendChild(skeleton);

    const reserved = (await fetchReservedSeats(scheduleId)) || [];
    grid.innerHTML = "";

    const cfg = SEAT_LAYOUT_CONFIG;
    const seats = generateSeatLayout(cfg);

    seats.forEach(s => {
        if (s.isAisle) {
            const div = document.createElement("div");
            div.className = "aisle";
            grid.appendChild(div);
            return;
        }
        const meta = classifySeat(s, cfg);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = meta.seatClass;
        btn.dataset.label = s.label;
        btn.title = [
            s.label,
            meta.isWindow ? "Window" : "",
            meta.isAisleSeat ? "Aisle" : "",
            meta.isMiddle ? "Middle" : "",
            meta.isFront ? "Front" : (meta.isBack ? "Back" : "")
        ].filter(Boolean).join(" • ");
        btn.textContent = s.label;

        if (reserved.includes(String(s.label).toUpperCase())) {
            btn.classList.add("booked");
            btn.disabled = true;
        } else {
            btn.addEventListener("click", () => {
                if (btn.classList.contains("booked")) return;
                const label = btn.dataset.label;
                if (btn.classList.contains("selected")) {
                    btn.classList.remove("selected");
                    selectedSeats = selectedSeats.filter(x => x !== label);
                } else {
                    btn.classList.add("selected");
                    selectedSeats.push(label);
                }
                updateSeatSelectionUI();
            });
        }
        grid.appendChild(btn);
    });

    updateSeatSelectionUI();
}

// ================== BOOKING FLOW ==================
async function bookSeat() {
    const schedule_id = document.getElementById("bookingScheduleSelect").value;
    const selectedCount = selectedSeats.length;
    const fallbackCount = parseInt(document.getElementById("bookingSeats").value) || 0;
    const seats = selectedCount || fallbackCount;

    if (!seats || seats < 1) {
        showMessage("bookingMessage", "Please select at least one seat.", true);
        return;
    }

    const baseAmount = seats * PER_SEAT_PRICE;
    const promoCode = (document.getElementById("promoCode").value || "").trim();
    const discountObj = calculateDiscount(baseAmount, promoCode);
    const finalAmount = baseAmount - (discountObj.discount || 0);

    try {
        // 1) Payment
        const payRes = await fetch(`${API_URL}/pay`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ amount: finalAmount })
        });
        const payData = await payRes.json().catch(() => ({}));
        if (!payRes.ok || !payData.payment_token) {
            showMessage("bookingMessage", payData.error || "Payment failed", true);
            return;
        }

        // 2) Booking
        const payload = {
            schedule_id, seats,
            payment_token: payData.payment_token,
            promo_code: promoCode || null,
            discount_applied: discountObj.discount || 0,
            amount_charged: finalAmount
        };
        if (selectedCount > 0) payload.seat_numbers = selectedSeats;

        const bookRes = await fetch(`${API_URL}/book`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify(payload)
        });
        const bookData = await bookRes.json().catch(() => ({}));
        if (bookRes.ok && bookData.booking_id) {
            showMessage("bookingMessage", `Booking successful! ID: ${bookData.booking_id}`, false);
            localStorage.setItem("hasBookedOnce", "true");
            // Clear seat input optionally
            // document.getElementById("bookingSeats").value = "";
            loadMyBookings();
            loadSchedules();
            loadBookingSchedules().then(() => renderSeatMap(schedule_id));
            clearSeatSelection();
            updateFareSummary();
        } else {
            showMessage("bookingMessage", bookData.error || "Booking failed", true);
        }
    } catch (err) {
        console.error(err);
        showMessage("bookingMessage", "Booking failed due to a network error.", true);
    }
}

// ================== CANCELLATION FLOW ==================
async function cancelBooking(bookingId, scheduleId) {
    const sched = scheduleMap[scheduleId];
    let confirmText = "Do you really want to cancel this ticket?";
    if (sched && isValidDate(new Date(sched.departure))) {
        const hrs = hoursUntil(sched.departure);
        if (hrs !== null) {
            if (hrs >= 24) confirmText += "\nPolicy: Full refund (subject to operator).";
            else if (hrs >= 3) confirmText += "\nPolicy: 50% refund (subject to operator).";
            else confirmText += "\nPolicy: Non-refundable (subject to operator).";
        }
    }
    if (!confirm(confirmText)) return;

    const reason = prompt("Optional: reason for cancellation (press OK to continue)", "") || "";

    try {
        const ok = await tryCancelBookingRequest(bookingId, reason);
        if (ok) {
            alert("Booking cancelled.");
            loadMyBookings();
            loadSchedules();
            loadBookingSchedules();
        } else {
            alert("Cancellation failed. Please try again.");
        }
    } catch (e) {
        console.error(e);
        alert("Cancellation error.");
    }
}
async function tryCancelBookingRequest(id, reason = "") {
    const headersJSON = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
    const headers = { 'Authorization': 'Bearer ' + token };
    try {
        let r1 = await fetch(`${API_URL}/cancel_booking/${id}`, { method: 'POST', headers, body: null });
        if (r1.ok) { const d1 = await r1.json().catch(() => ({})); if (d1.success !== false) return true; }
    } catch (_) {}
    try {
        let r2 = await fetch(`${API_URL}/bookings/${id}`, { method: 'DELETE', headers });
        if (r2.ok) { const d2 = await r2.json().catch(() => ({})); if (d2.success !== false) return true; }
    } catch (_) {}
    try {
        let r3 = await fetch(`${API_URL}/cancel_booking`, {
            method: 'POST', headers: headersJSON, body: JSON.stringify({ booking_id: id, reason })
        });
        if (r3.ok) { const d3 = await r3.json().catch(() => ({})); if (d3.success !== false) return true; }
    } catch (_) {}
    return false;
}

// ================== RATING FLOW ==================
function openRating(bookingId) {
    ratingForBookingId = bookingId;
    selectedStars = ratingsLocal[bookingId]?.rating || 0;
    document.getElementById("ratingComment").value = ratingsLocal[bookingId]?.comment || "";
    document.querySelectorAll("#ratingStars .star").forEach((el, idx) => {
        el.classList.toggle("selected", idx < selectedStars);
    });
    document.getElementById("ratingInfo").innerText = selectedStars ? `Selected: ${selectedStars}/5` : "Select stars";
    document.getElementById("ratingModal").style.display = "flex";
}
function closeRating() {
    ratingForBookingId = null;
    selectedStars = 0;
    document.querySelectorAll("#ratingStars .star").forEach(s => s.classList.remove("selected", "hovered"));
    document.getElementById("ratingComment").value = "";
    document.getElementById("ratingInfo").innerText = "Select stars";
    document.getElementById("ratingModal").style.display = "none";
}
async function submitRating() {
    if (!ratingForBookingId) return;
    if (!selectedStars) {
        alert("Please select a star rating.");
        return;
    }
    const comment = document.getElementById("ratingComment").value || "";
    ratingsLocal[ratingForBookingId] = { rating: selectedStars, comment, ts: Date.now() };
    localStorage.setItem("ridesphere_ratings", JSON.stringify(ratingsLocal));

    try {
        const payload = { booking_id: ratingForBookingId, rating: selectedStars, comment };
        const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
        let r = await fetch(`${API_URL}/rate_booking`, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!r.ok) {
            await fetch(`${API_URL}/bookings/${ratingForBookingId}/rating`, { method: 'POST', headers, body: JSON.stringify({ rating: selectedStars, comment }) });
        }
    } catch (e) {
        console.warn("Rating API not available, stored locally.");
    }
    closeRating();
    renderBookingsTable();
    alert("Thanks for your feedback!");
}
// Stars events
document.querySelectorAll("#ratingStars .star").forEach(starEl => {
    starEl.addEventListener("mouseenter", (e) => {
        const val = parseInt(e.target.dataset.v);
        document.querySelectorAll("#ratingStars .star").forEach((s, idx) => {
            s.classList.toggle("hovered", idx < val);
        });
    });
    starEl.addEventListener("mouseleave", () => {
        document.querySelectorAll("#ratingStars .star").forEach(s => s.classList.remove("hovered"));
    });
    starEl.addEventListener("click", (e) => {
        selectedStars = parseInt(e.target.dataset.v);
        document.querySelectorAll("#ratingStars .star").forEach((s, idx) => {
            s.classList.toggle("selected", idx < selectedStars);
        });
        const info = document.getElementById("ratingInfo");
        info.innerText = `Selected: ${selectedStars}/5`;
    });
});

// ================== ADMIN CRUD ==================
async function addRoute() {
    const name = document.getElementById("routeName").value.trim();
    const origin = document.getElementById("routeOrigin").value.trim();
    const dest = document.getElementById("routeDestination").value.trim();
    if (!name || !origin || !dest) {
        alert("All route fields required");
        return;
    }
    try {
        const res = await fetch(`${API_URL}/admin/add_route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ name, origin, destination: dest })
        });
        const data = await res.json().catch(() => ({}));
        alert(data.message || data.error || "Request sent");
        loadRoutes();
    } catch (err) {
        alert("Failed to add route");
    }
}

async function addSchedule() {
    const route_id = document.getElementById("adminRouteSelect").value;
    const bus_name = document.getElementById("adminBusName").value.trim();
    const departure = document.getElementById("adminDeparture").value;
    const seats = document.getElementById("adminSeats").value;
    if (!bus_name || !departure || !seats || seats < 1) {
        alert("All schedule fields required");
        return;
    }
    try {
        const res = await fetch(`${API_URL}/admin/add_schedule`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ route_id, bus_name, departure, seats_available: seats })
        });
        const data = await res.json().catch(() => ({}));
        alert(data.message || data.error || "Request sent");
        loadSchedules();
        loadBookingSchedules();
    } catch (err) {
        alert("Failed to add schedule");
    }
}

async function updateRoute(id) {
    const row = document.querySelector(`#route-${id}`);
    const name = row.children[1].innerText.trim();
    const origin = row.children[2].innerText.trim();
    const dest = row.children[3].innerText.trim();
    try {
        const res = await fetch(`${API_URL}/admin/update_route/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ name, origin, destination: dest })
        });
        const data = await res.json().catch(() => ({}));
        alert(data.message || data.error || "Request sent");
        loadRoutes();
    } catch (err) {
        alert("Failed to update route");
    }
}

async function deleteSchedule(id) {
    if (!confirm("Delete this schedule?")) return;
    try {
        const res = await fetch(`${API_URL}/admin/delete_schedule/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json().catch(() => ({}));
        alert(data.message || data.error || "Request sent");
        loadSchedules();
        loadBookingSchedules();
    } catch (err) {
        alert("Failed to delete schedule");
    }
}

async function updateSchedule(id) {
    const row = document.querySelector(`#sched-${id}`);
    const route_id_or_name = row.children[1].innerText.trim();
    const bus_name = row.children[2].innerText.trim();
    const departure = row.children[3].innerText.trim();
    const seats = row.children[4].innerText.trim();
    let route_id = Object.values(routeMap).find(r => r.name === route_id_or_name)?.id || route_id_or_name;
    try {
        const res = await fetch(`${API_URL}/admin/update_schedule/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ route_id, bus_name, departure, seats_available: seats })
        });
        const data = await res.json().catch(() => ({}));
        alert(data.message || data.error || "Request sent");
        loadSchedules();
        loadBookingSchedules();
    } catch (err) {
        alert("Failed to update schedule");
    }
}

async function deleteRoute(id) {
    if (!confirm("Delete this route?")) return;
    try {
        const res = await fetch(`${API_URL}/admin/delete_route/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json().catch(() => ({}));
        alert(data.message || data.error || "Request sent");
        loadRoutes();
    } catch (err) {
        alert("Failed to delete route");
    }
}

async function viewQR(booking_id) {
    try {
        const res = await fetch(`${API_URL}/booking_qr/${booking_id}`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.qr_base64) {
            document.getElementById("qrImage").src = "data:image/png;base64," + data.qr_base64;
            document.getElementById("qrModal").style.display = "flex";
        } else {
            alert(data.error || "Failed to load QR");
        }
    } catch (err) {
        alert("Failed to load QR");
    }
}
function closeQR() { document.getElementById("qrModal").style.display = "none"; }

// ================== BOOTSTRAP ==================
document.getElementById("bookingSeats").addEventListener("input", updateFareSummary);
document.getElementById("bookingScheduleSelect").addEventListener("change", () => {
    updateFareSummary();
    renderSeatMap(document.getElementById("bookingScheduleSelect").value);
});

renderOffers();
checkAdmin().then(() => {
    loadRoutes().then(() => {
        loadSchedules().then(() => {
            loadBookingSchedules();
            loadMyBookings();
        });
    });
});
// Footer: set current year
(function setFooterYear() {
  const el = document.getElementById('copyrightYear');
  if (el) el.textContent = 2025; // kept as you set
})();

// ============ APP RATING POPUP ============
let appSelectedStars = 0;

function openAppRating() {
  appSelectedStars = 0;
  // reset UI
  document.querySelectorAll("#appRatingStars .star").forEach(s => s.classList.remove("selected","hovered"));
  const info = document.getElementById("appRatingInfo");
  if (info) info.innerText = "How are we doing?";
  const ta = document.getElementById("appRatingComment");
  if (ta) ta.value = "";
  const modal = document.getElementById("appRatingModal");
  if (modal) modal.style.display = "flex";
}

function closeAppRating() {
  const modal = document.getElementById("appRatingModal");
  if (modal) modal.style.display = "none";
}

async function submitAppRating() {
  if (!appSelectedStars) {
    alert("Please select a star rating.");
    return;
  }
  const comment = (document.getElementById("appRatingComment")?.value || "").trim();

  // save locally so we don't show again
  localStorage.setItem("appRatingSubmitted", "true");
  localStorage.setItem("appRatingData", JSON.stringify({ rating: appSelectedStars, comment, ts: Date.now() }));

  // Try to send to API if available
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (localStorage.getItem("authToken") || '') };
  const payload = { rating: appSelectedStars, comment, platform: 'web' };
  try {
    // Try primary endpoint
    let r = await fetch(`${API_URL}/app_rating`, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!r.ok) {
      // Try a fallback endpoint if your backend uses different naming
      await fetch(`${API_URL}/feedback`, { method: 'POST', headers, body: JSON.stringify(payload) });
    }
  } catch (e) {
    console.warn("App rating API not available, stored locally.");
  }

  closeAppRating();
  alert("Thanks for rating RideSphere!");
}

// Star interactions for app rating
document.querySelectorAll("#appRatingStars .star").forEach(starEl => {
  starEl.addEventListener("mouseenter", (e) => {
    const val = parseInt(e.target.dataset.v);
    document.querySelectorAll("#appRatingStars .star").forEach((s, idx) => {
      s.classList.toggle("hovered", idx < val);
    });
  });
  starEl.addEventListener("mouseleave", () => {
    document.querySelectorAll("#appRatingStars .star").forEach(s => s.classList.remove("hovered"));
  });
  starEl.addEventListener("click", (e) => {
    appSelectedStars = parseInt(e.target.dataset.v);
    document.querySelectorAll("#appRatingStars .star").forEach((s, idx) => {
      s.classList.toggle("selected", idx < appSelectedStars);
    });
    const info = document.getElementById("appRatingInfo");
    if (info) info.innerText = `Selected: ${appSelectedStars}/5`;
  });
});

// Show the app rating popup occasionally (auto)
function maybeShowAppRatingPrompt() {
  // Don't show if already submitted
  if (localStorage.getItem("appRatingSubmitted") === "true") return;

  // Don't show more than once every 2 days
  const lastShown = parseInt(localStorage.getItem("appRatingLastShown") || "0", 10);
  const twoDays = 2 * 24 * 60 * 60 * 1000;
  if (Date.now() - lastShown < twoDays) return;

  setTimeout(() => openAppRating(), 1500); // show after small delay
  localStorage.setItem("appRatingLastShown", Date.now().toString());
}

// Call it after your data loads (keep your existing bootstrap)
maybeShowAppRatingPrompt();
