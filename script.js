const container = document.getElementById("container");
const registerBtn = document.getElementById("register");
const loginBtn = document.getElementById("login");
const darkToggle = document.getElementById("darkToggle");

registerBtn.addEventListener("click", () => container.classList.add("active"));
loginBtn.addEventListener("click", () => container.classList.remove("active"));

// ================== BACKEND CONFIG ==================
const API_URL = "http://127.0.0.1:5000/api"; // Flask backend

// Show messages
function showMessage(targetId, text, type) {
    const el = document.getElementById(targetId);
    el.innerText = text;
    el.className = "message " + type;
    el.style.display = "block";
    el.style.opacity = "1";
    setTimeout(() => {
        el.style.opacity = "0";
        setTimeout(() => { el.style.display = "none"; }, 500);
    }, 3000);
}

// Gmail validation
function isValidGmail(email) {
    return /^[a-zA-Z0-9._%+-]+@gmail.com$/.test(email);
}

// Password strength checker
function checkStrength(password, targetId) {
    const el = document.getElementById(targetId);
    if (!password) { el.innerText = ""; return; }
    let strength = 0;
    if (password.length >= 6) strength++;
    if (/[A-Z]/.test(password)) strength++;
    if (/[0-9]/.test(password)) strength++;
    if (/[^A-Za-z0-9]/.test(password)) strength++; // special char required

    if (strength < 2) {
        el.innerText = "Weak";
        el.className = "strength-text strength-weak";
    } else if (strength === 2 || strength === 3) {
        el.innerText = "Medium";
        el.className = "strength-text strength-medium";
    } else {
        el.innerText = "Strong";
        el.className = "strength-text strength-strong";
    }
}

// Toggle password visibility
function togglePassword(inputId, el) {
    const input = document.getElementById(inputId);
    if (input.type === "password") {
        input.type = "text";
        el.innerText = "🙈";
    } else {
        input.type = "password";
        el.innerText = "👁";
    }
}

// Dark mode toggle
darkToggle.addEventListener("click", () => {
    document.body.classList.toggle("dark-mode");
    darkToggle.innerText = document.body.classList.contains("dark-mode") ? "☀️" : "🌙";
});

// ================== OTP ==================
let currentOTP = {};

function generateOTP() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function sendOTP(type) {
    if (type === "signup") {
        const email = document.getElementById("email-signup").value.trim();
        const phone = document.getElementById("phone-signup").value.trim();
        const password = document.getElementById("password-signup").value.trim();
        if (!isValidGmail(email)) {
            showMessage("signup-message", "Email must end with @gmail.com", "error");
            return;
        }
        if (phone.length !== 10) {
            showMessage("signup-message", "Phone must be 10 digits", "error");
            return;
        }
        if (!/[^A-Za-z0-9]/.test(password)) {
            showMessage("signup-message", "Password must include a special character", "error");
            return;
        }

        currentOTP.signup = generateOTP();
        showMessage("signup-message", `OTP sent: ${currentOTP.signup}`, "success");
        document.getElementById("otp-section-signup").style.display = "block";
    } else if (type === "forgot") {
        const phone = document.getElementById("phone-forgot").value.trim();
        if (phone.length !== 10) {
            showMessage("forgot-message", "Phone must be 10 digits", "error");
            return;
        }
        currentOTP.forgot = generateOTP();
        showMessage("forgot-message", `OTP sent: ${currentOTP.forgot}`, "success");
        document.getElementById("forgot-step-phone").style.display = "none";
        document.getElementById("otp-section-forgot").style.display = "block";
    }
}

// ================== VERIFY OTP ==================
async function verifyOTP(type) {
    if (type === "signup") {
        const enteredOTP = document.getElementById("otp-signup").value.trim();
        if (enteredOTP !== currentOTP.signup) {
            showMessage("signup-message", "Invalid OTP", "error");
            return;
        }
        const email = document.getElementById("email-signup").value.trim();
        const phone = document.getElementById("phone-signup").value.trim();
        const password = document.getElementById("password-signup").value.trim();

        try {
            const res = await fetch(`${API_URL}/signup`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, phone, password })
            });

            const data = await res.json();
            if (res.ok) {
                showMessage("signup-message", "Signup successful! You can now log in.", "success");
                document.getElementById("otp-section-signup").style.display = "none";
                container.classList.remove("active");
            } else {
                showMessage("signup-message", "❌ " + (data.error || "Signup failed"), "error");
            }
        } catch (err) {
            showMessage("signup-message", "Server error. Please try again.", "error");
        }
    } else if (type === "forgot") {
        const enteredOTP = document.getElementById("otp-forgot").value.trim();
        if (enteredOTP !== currentOTP.forgot) {
            showMessage("forgot-message", "Invalid OTP", "error");
            return;
        }
        document.getElementById("otp-section-forgot").style.display = "none";
        document.getElementById("reset-password-section").style.display = "block";
    }
}

// ================== LOGIN USER ==================
async function loginUser() {
    const email = document.getElementById("email-signin").value.trim();
    const phone = document.getElementById("phone-signin").value.trim();
    const password = document.getElementById("password-signin").value.trim();
    const msg = document.getElementById("login-message");
    if (!email || !phone || !password) {
        showMessage("login-message", "Please fill all fields.", "error");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, phone, password })
        });

        const data = await res.json();

        if (res.ok) {
            localStorage.setItem("authToken", data.token);
            showMessage("login-message", "✅ Login successful! Redirecting...", "success");

            setTimeout(() => {
                window.location.href = "dashboard.html";
            }, 1000);
        } else {
            showMessage("login-message", "❌ " + (data.error || "Invalid credentials"), "error");
        }
    } catch (err) {
        showMessage("login-message", "❌ Server error", "error");
    }
}

// ================== RESET PASSWORD ==================
async function resetPassword() {
    const phone = document.getElementById("phone-forgot").value.trim();
    const newPass = document.getElementById("new-password").value.trim();
    if (newPass.length < 6 || !/[^A-Za-z0-9]/.test(newPass)) {
        showMessage("forgot-message", "Password must be at least 6 characters and include a special character", "error");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/reset_password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone, new_password: newPass })
        });

        const data = await res.json();
        if (res.ok) {
            showMessage("forgot-message", "Password reset successful! Please log in.", "success");
            closeForgotPassword();
        } else {
            showMessage("forgot-message", "❌ " + (data.error || "Reset failed"), "error");
        }
    } catch (err) {
        showMessage("forgot-message", "❌ Server error", "error");
    }
}

// Forgot Password modal
function openForgotPassword() {
    document.getElementById("forgotModal").style.display = "flex";
    document.getElementById("forgot-step-phone").style.display = "block";
    document.getElementById("otp-section-forgot").style.display = "none";
    document.getElementById("reset-password-section").style.display = "none";
    document.getElementById("forgot-message").style.display = "none";
}

function closeForgotPassword() {
    document.getElementById("forgotModal").style.display = "none";
}
