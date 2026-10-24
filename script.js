
// ==========================================
// نظام استفسارات المتعاملين
// ==========================================

// الاستفسارات القديمة المحفوظة في المتصفح (قبل Firebase)
const STORAGE_KEY = "customerRecords";

// مجموعة الاستفسارات في قاعدة البيانات
const INQUIRIES_COLLECTION = "inquiries";

// الموظف يدخل باسم المستخدم فقط، ويُكمَل الإيميل تلقائياً
// مثال: اسم المستخدم ahmed => ahmed@dhaid-inquiries.app
// الحسابات تُضاف من Firebase Console > Authentication > Users
const STAFF_EMAIL_DOMAIN = "@dhaid-inquiries.app";

// مدير النظام: الوحيد المسموح له بالحذف
// (نفس الإيميل موجود في firestore.rules)
// يدخل بالإيميل كاملاً بدل اسم المستخدم
const SYSTEM_ADMIN_EMAIL = "mundhaidshj@gmail.com";

let currentInquiryFilter = "لم يتم الرد";
let selectedInquiryId = null;

let db = null;
let cachedRecords = [];
let stopListening = null;
let stopListeningStaff = null;

// قائمة الموظفين المسموح لهم (رقم المستند = إيميل الموظف)
const STAFF_COLLECTION = "staff";

// رموز الدخول اليومية (رقم المستند = الرمز نفسه)
// تُعرض داخل QR على شاشة الاستقبال، والمتعامل لا يستطيع الإرسال بدونها
const ACCESS_CODES_COLLECTION = "accessCodes";

const ACCESS_CODE_KEY = "inquiryAccessCode";


// ==========================================
// 1. الاتصال بقاعدة البيانات
// ==========================================

let firebaseReady = null;

// صفحة المتعامل تدخل كزائر تلقائياً
// صفحة المتابعة تحتاج تسجيل دخول الموظف
function initFirebase(signInAsGuest = true) {

    if (firebaseReady) {
        return firebaseReady;
    }

    firebaseReady = new Promise((resolve, reject) => {

        firebase.initializeApp(FIREBASE_CONFIG);

        db = firebase.firestore();

        // الانتظار حتى يتم استرجاع جلسة الدخول السابقة (إن وجدت)
        const unsubscribe = firebase.auth()
            .onAuthStateChanged(async user => {

                unsubscribe();

                try {
                    if (!user && signInAsGuest) {
                        await firebase.auth().signInAnonymously();
                    }

                    resolve();

                } catch (error) {
                    reject(error);
                }
            });
    });

    return firebaseReady;
}


// ==========================================
// 2. قراءة الاستفسارات
// ==========================================

function getRecords() {
    return cachedRecords.slice();
}

function findRecord(id) {
    return cachedRecords.find(item => item.id === id);
}

// متابعة الاستفسارات مباشرة من قاعدة البيانات
function listenToInquiries() {

    stopListening = db.collection(INQUIRIES_COLLECTION)
        .onSnapshot(snapshot => {

            cachedRecords = snapshot.docs
                .map(doc => Object.assign({}, doc.data(), { id: doc.id }))
                .sort((a, b) =>
                    parseInt(a.id, 10) - parseInt(b.id, 10)
                );

            displayInquiries();

            // إغلاق التفاصيل إذا تم حذف الاستفسار من جهاز آخر
            if (selectedInquiryId && !findRecord(selectedInquiryId)) {

                selectedInquiryId = null;

                document.getElementById("inquiryDetails")
                    .style.display = "none";
            }

        }, error => {

            console.error("خطأ في قراءة الاستفسارات:", error);

            alert("تعذر الاتصال بقاعدة البيانات");
        });
}

// نقل الاستفسارات القديمة من هذا المتصفح إلى قاعدة البيانات (مرة واحدة)
async function migrateLocalRecords() {

    let oldRecords = [];

    try {
        oldRecords = JSON.parse(
            localStorage.getItem(STORAGE_KEY) || "[]"
        );
    } catch (error) {
        return;
    }

    if (!Array.isArray(oldRecords) || oldRecords.length === 0) {
        return;
    }

    try {

        const batch = db.batch();

        oldRecords.forEach(record => {

            if (!record || !record.id) {
                return;
            }

            batch.set(
                db.collection(INQUIRIES_COLLECTION).doc(record.id),
                Object.assign({}, record, {
                    isoDate: getRecordIsoDate(record),
                    replyNotes: record.replyNotes || "",
                    status: record.status === "تم الرد"
                        ? "تم الرد"
                        : "لم يتم الرد"
                })
            );
        });

        await batch.commit();

        localStorage.removeItem(STORAGE_KEY);

    } catch (error) {
        console.error("تعذر نقل الاستفسارات القديمة:", error);
    }
}


// ==========================================
// 3. الانتقال إلى المرحلة الثانية
// ==========================================

function nextStep() {

    const name = document
        .getElementById("customerName")
        .value.trim();

    const phone = document
        .getElementById("customerPhone")
        .value.trim();

    if (!name || !phone) {
        alert("يرجى إدخال اسم المتعامل ورقم الهاتف");
        return;
    }

    // رقم إماراتي: 8 إلى 10 أرقام بدون مفتاح الدولة
    const phoneDigits = normalizeDigits(phone).replace(/\D/g, "");

    if (phoneDigits.length < 8 || phoneDigits.length > 10) {
        alert("يرجى إدخال رقم هاتف صحيح (مثال: 501234567)");
        return;
    }

    const now = new Date();

    document.getElementById("showName").textContent =
        name;

    document.getElementById("showPhone").textContent =
        "+971 " + phone;

    document.getElementById("showDay").textContent =
        now.toLocaleDateString("ar-AE", {
            weekday: "long"
        });

    document.getElementById("showDate").textContent =
        now.toLocaleDateString("ar-AE");

    document.getElementById("showTime").textContent =
        now.toLocaleTimeString("ar-AE", {
            hour: "2-digit",
            minute: "2-digit"
        });

    document.getElementById("step1").style.display =
        "none";

    document.getElementById("step2").style.display =
        "block";
}


// ==========================================
// 4. إرسال استفسار المتعامل
// ==========================================

async function sendInquiry() {

    const employeeInput =
        document.getElementById("employeeName");

    const inquiryInput =
        document.getElementById("inquiry");

    const employee = employeeInput.value.trim();
    const inquiry = inquiryInput.value.trim();

    const type = getSelectedRequestType();

    if (!employee || !inquiry) {
        alert("يرجى إدخال اسم الموظف و" + (type === "شكوى" ? "الشكوى" : "الاستفسار"));
        return;
    }

    const record = {

        id: Date.now().toString() + "-" +
            Math.random().toString(36).slice(2),

        name: document.getElementById("showName")
            .textContent,

        phone: document.getElementById("showPhone")
            .textContent,

        day: document.getElementById("showDay")
            .textContent,

        date: document.getElementById("showDate")
            .textContent,

        time: document.getElementById("showTime")
            .textContent,

        employee: employee,

        inquiry: inquiry,

        // نوع الطلب: استفسار أو شكوى
        type: type,

        // رمز QR الذي مسحه المتعامل في الإدارة
        accessCode: getStoredAccessCode(),

        // التاريخ بصيغة ثابتة لاستخدامه في الفلترة
        isoDate: toIsoDate(new Date()),

        status: "لم يتم الرد",

        // ملاحظات الرد تكون فارغة عند التسجيل
        replyNotes: ""
    };

    const sendButton =
        document.querySelector("#step2 button");

    // منع الإرسال المكرر أثناء الحفظ
    sendButton.disabled = true;

    const message = document.getElementById("message");

    message.textContent = "جاري إرسال الاستفسار...";

    try {

        await initFirebase();

        await db.collection(INQUIRIES_COLLECTION)
            .doc(record.id)
            .set(record);

        message.textContent =
            type === "شكوى"
                ? "تم تسجيل الشكوى بنجاح"
                : "تم تسجيل الاستفسار بنجاح";

        employeeInput.disabled = true;
        inquiryInput.disabled = true;

        setRequestTypeDisabled(true);

        // الرمز يُستخدم مرة واحدة: لطلب جديد يجب مسح QR مرة أخرى
        clearStoredAccessCode();

        message.textContent +=
            " — لتقديم طلب آخر، امسح رمز QR الموجود في الإدارة مرة أخرى";

    } catch (error) {

        console.error("خطأ في حفظ الاستفسار:", error);

        message.textContent = "";

        // الرفض يعني غالباً أن الرمز انتهى (من يوم سابق)
        if (error && error.code === "permission-denied") {

            clearStoredAccessCode();

            showAccessBlocked(
                "انتهت صلاحية الرمز. يرجى مسح رمز QR الموجود في الإدارة من جديد"
            );
            return;
        }

        sendButton.disabled = false;

        alert("حدث خطأ أثناء حفظ الاستفسار، تأكد من الاتصال بالإنترنت وحاول مرة أخرى");
    }
}


// ==========================================
// 4-ب. نوع الطلب (استفسار / شكوى)
// ==========================================

function getSelectedRequestType() {

    const selected = document.querySelector(
        'input[name="requestType"]:checked'
    );

    return selected ? selected.value : "استفسار";
}

function setRequestTypeDisabled(disabled) {

    document.querySelectorAll('input[name="requestType"]')
        .forEach(input => {
            input.disabled = disabled;
        });
}

// تغيير عنوان الخانة حسب النوع المختار
function updateRequestTypeLabels() {

    const isComplaint = getSelectedRequestType() === "شكوى";

    document.getElementById("inquiryLabel").textContent =
        isComplaint ? "الشكوى" : "الاستفسار";

    document.getElementById("inquiry").placeholder =
        isComplaint ? "اكتب شكواك هنا" : "اكتب استفسارك هنا";
}

// إضافة عنوان عمود "النوع" إذا كانت الصفحة نسخة قديمة محفوظة في المتصفح
function ensureTypeHeader() {

    const headerRow =
        document.querySelector("#inquiriesTable thead tr");

    if (!headerRow || headerRow.children.length >= 7) {
        return;
    }

    const typeHeader = document.createElement("th");

    typeHeader.textContent = "النوع";

    headerRow.insertBefore(typeHeader, headerRow.children[2]);
}

// شارة ملونة لنوع الطلب في صفحة المتابعة
// الطلبات القديمة بدون نوع تعتبر استفسار
function createTypeBadge(type) {

    const badge = document.createElement("span");

    const isComplaint = type === "شكوى";

    badge.className = isComplaint
        ? "type-badge type-badge-complaint"
        : "type-badge type-badge-inquiry";

    badge.textContent = isComplaint ? "شكوى" : "استفسار";

    return badge;
}


// ==========================================
// 5. تسجيل استفسار جديد
// ==========================================

function showCustomerPage() {

    document.getElementById("customerName").value = "";
    document.getElementById("customerPhone").value = "";
    document.getElementById("employeeName").value = "";
    document.getElementById("inquiry").value = "";

    document.getElementById("employeeName").disabled =
        false;

    document.getElementById("inquiry").disabled =
        false;

    // الرجوع إلى "استفسار" كاختيار افتراضي
    setRequestTypeDisabled(false);

    document.querySelector(
        'input[name="requestType"][value="استفسار"]'
    ).checked = true;

    updateRequestTypeLabels();

    const sendButton =
        document.querySelector("#step2 button");

    if (sendButton) {
        sendButton.disabled = false;
    }

    document.getElementById("message").textContent = "";

    const newButton =
        document.getElementById("newInquiryButton");

    if (newButton) {
        newButton.style.display = "none";
    }

    document.getElementById("step1").style.display =
        "block";

    document.getElementById("step2").style.display =
        "none";
}


// ==========================================
// 6. تحديث أعداد الاستفسارات
// ==========================================

function updateInquiryCounts(records) {

    const total = records.length;

    const pending = records.filter(
        record => record.status !== "تم الرد"
    ).length;

    const replied = records.filter(
        record => record.status === "تم الرد"
    ).length;

    document.getElementById("totalCount").textContent =
        total;

    document.getElementById("pendingCount").textContent =
        pending;

    document.getElementById("repliedCount").textContent =
        replied;
}


// ==========================================
// 7. التنقل بين خانات الاستفسارات
// ==========================================

function filterInquiries(status) {

    currentInquiryFilter = status;

    selectedInquiryId = null;

    document.getElementById("inquiryDetails").style.display =
        "none";

    displayInquiries();
}


// ==========================================
// 8. عرض الاستفسارات
// ==========================================

function displayInquiries() {

    const tbody =
        document.getElementById("inquiriesTableBody");

    if (!tbody) {
        return;
    }

    const records = getRecords();

    tbody.innerHTML = "";

    updateInquiryCounts(records);

    document.getElementById("pendingTab")
        .classList.toggle(
            "active",
            currentInquiryFilter === "لم يتم الرد"
        );

    document.getElementById("repliedTab")
        .classList.toggle(
            "active",
            currentInquiryFilter === "تم الرد"
        );

    const nameFilter =
        getFilterValue("filterCustomerName");

    const phoneFilter =
        normalizeDigits(getFilterValue("filterPhone"))
            .replace(/\D/g, "");

    const employeeFilter =
        getFilterValue("filterEmployee");

    const dateFilter =
        getFilterValue("filterDate");

    const filteredRecords = records.filter(record => {

        const statusMatches =
            currentInquiryFilter === "تم الرد"
                ? record.status === "تم الرد"
                : record.status !== "تم الرد";

        if (!statusMatches) {
            return false;
        }

        if (
            nameFilter &&
            !(record.name || "").toLowerCase()
                .includes(nameFilter)
        ) {
            return false;
        }

        if (
            phoneFilter &&
            !normalizeDigits(record.phone || "")
                .replace(/\D/g, "")
                .includes(phoneFilter)
        ) {
            return false;
        }

        if (
            employeeFilter &&
            !(record.employee || "").toLowerCase()
                .includes(employeeFilter)
        ) {
            return false;
        }

        if (
            dateFilter &&
            getRecordIsoDate(record) !== dateFilter
        ) {
            return false;
        }

        return true;
    });

    const emptyMessage =
        document.getElementById("emptyMessage");

    if (emptyMessage) {

        emptyMessage.style.display =
            filteredRecords.length === 0
                ? "block"
                : "none";

        emptyMessage.textContent =
            currentInquiryFilter === "تم الرد"
                ? "لا توجد استفسارات تم الرد عليها حالياً"
                : "لا توجد استفسارات بانتظار الرد حالياً";
    }

    filteredRecords.forEach((record, index) => {

        const row = document.createElement("tr");

        function addCell(value) {

            const cell = document.createElement("td");

            cell.textContent = value ?? "";

            row.appendChild(cell);
        }

        addCell(index + 1);
        addCell(record.name);

        ensureTypeHeader();

        const typeCell = document.createElement("td");

        typeCell.appendChild(createTypeBadge(record.type));

        row.appendChild(typeCell);
        addCell(record.date);
        addCell(record.employee);

        const statusCell =
            document.createElement("td");

        const statusLabel =
            document.createElement("span");

        if (record.status === "تم الرد") {

            statusLabel.className =
                "status-replied";

            statusLabel.textContent =
                "تم الرد";

        } else {

            statusLabel.className =
                "status-not-replied";

            statusLabel.textContent =
                "لم يتم الرد";
        }

        statusCell.appendChild(statusLabel);

        row.appendChild(statusCell);

        const detailsCell =
            document.createElement("td");

        const detailsButton =
            document.createElement("button");

        detailsButton.type = "button";

        detailsButton.textContent =
            "عرض التفاصيل";

        detailsButton.className =
            "details-button";

        detailsButton.onclick = function () {
            openInquiry(record.id);
        };

        detailsCell.appendChild(detailsButton);

        row.appendChild(detailsCell);

        tbody.appendChild(row);
    });
}


// ==========================================
// 9. فتح تفاصيل الاستفسار
// ==========================================

function openInquiry(id) {

    const record = findRecord(id);

    if (!record) {
        alert("لم يتم العثور على الاستفسار");
        return;
    }

    selectedInquiryId = id;

    document.getElementById("detailName").textContent =
        record.name || "";

    // قد تكون الصفحة نسخة قديمة محفوظة في المتصفح بدون خانة النوع
    const detailType = document.getElementById("detailType");

    if (detailType) {

        detailType.innerHTML = "";

        detailType.appendChild(createTypeBadge(record.type));
    }

    document.getElementById("detailPhone").textContent =
        record.phone || "";

    document.getElementById("detailDay").textContent =
        record.day || "";

    document.getElementById("detailDate").textContent =
        record.date || "";

    document.getElementById("detailTime").textContent =
        record.time || "";

    document.getElementById("detailEmployee").textContent =
        record.employee || "";

    document.getElementById("detailInquiry").textContent =
        record.inquiry || "";

    // استرجاع ملاحظات الرد المحفوظة
    document.getElementById("replyNotes").value =
        record.replyNotes || "";

    document.getElementById("inquiryStatus").value =
        record.status === "تم الرد"
            ? "تم الرد"
            : "لم يتم الرد";

    updateAdminView();

    const details =
        document.getElementById("inquiryDetails");

    details.style.display = "block";

    details.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
}


// ==========================================
// 10. حفظ حالة الاستفسار وملاحظات الرد
// ==========================================

async function updateInquiryStatus() {

    if (!selectedInquiryId) {

        alert("يرجى اختيار استفسار أولاً");
        return;
    }

    const record = findRecord(selectedInquiryId);

    if (!record) {

        alert("لم يتم العثور على الاستفسار");
        return;
    }

    const newStatus =
        document.getElementById("inquiryStatus").value;

    if (
        newStatus !== "تم الرد" &&
        newStatus !== "لم يتم الرد"
    ) {
        alert("حالة الاستفسار غير صحيحة");
        return;
    }

    // حفظ الملاحظة مع نفس الاستفسار
    const notes =
        document.getElementById("replyNotes").value.trim();

    try {

        await db.collection(INQUIRIES_COLLECTION)
            .doc(selectedInquiryId)
            .update({
                status: newStatus,
                replyNotes: notes
            });

        document.getElementById("inquiryDetails")
            .style.display = "none";

        selectedInquiryId = null;

        alert("تم حفظ حالة الاستفسار وملاحظات الرد بنجاح");

    } catch (error) {

        console.error("خطأ في الحفظ:", error);

        alert("تعذر حفظ حالة الاستفسار والملاحظات");
    }
}


// ==========================================
// 11. تشغيل صفحة المتابعة تلقائياً
// ==========================================

document.addEventListener(
    "DOMContentLoaded",
    async function () {

        const isDashboard = Boolean(
            document.getElementById(
                "inquiriesTableBody"
            )
        );

        const isKiosk = Boolean(
            document.getElementById("qrBox")
        );

        const isCustomerPage = !isDashboard && !isKiosk;

        if (isDashboard) {
            displayInquiries();
        }

        // صفحة المتعامل: أخذ الرمز من رابط QR وإخفاؤه من شريط العنوان
        if (isCustomerPage) {
            captureAccessCodeFromUrl();
        }

        try {

            await initFirebase(isCustomerPage);

        } catch (error) {

            console.error("خطأ في الاتصال بقاعدة البيانات:", error);

            alert("تعذر الاتصال بقاعدة البيانات، تأكد من الاتصال بالإنترنت");
            return;
        }

        if (isDashboard) {
            firebase.auth().onAuthStateChanged(handleStaffAuthChange);
        }

        if (isKiosk) {
            firebase.auth().onAuthStateChanged(handleKioskAuthChange);
        }

        if (isCustomerPage) {
            await checkCustomerAccess();
        }

    }
);


// ==========================================
// 12. أدوات الفلترة
// ==========================================

function toIsoDate(date) {

    const month = String(date.getMonth() + 1)
        .padStart(2, "0");

    const day = String(date.getDate())
        .padStart(2, "0");

    return date.getFullYear() + "-" + month + "-" + day;
}

// الاستفسارات القديمة ليس فيها isoDate
// فيتم أخذ التاريخ من رقم الاستفسار (وقت التسجيل)
function getRecordIsoDate(record) {

    if (record.isoDate) {
        return record.isoDate;
    }

    const timestamp = parseInt(record.id, 10);

    return isNaN(timestamp)
        ? ""
        : toIsoDate(new Date(timestamp));
}

// تحويل الأرقام العربية (٠١٢...) إلى أرقام إنجليزية
function normalizeDigits(text) {

    return text.replace(/[٠-٩]/g, digit =>
        String(digit.charCodeAt(0) - 1632)
    );
}

function getFilterValue(id) {

    const input = document.getElementById(id);

    return input
        ? input.value.trim().toLowerCase()
        : "";
}

function clearInquiryFilters() {

    [
        "filterCustomerName",
        "filterPhone",
        "filterEmployee",
        "filterDate"
    ].forEach(id => {

        const input = document.getElementById(id);

        if (input) {
            input.value = "";
        }
    });

    displayInquiries();
}


// ==========================================
// 13. تسجيل دخول الموظفين
// ==========================================

// الموظف = أي حساب أضافه مدير النظام (ليس زائراً)
function isStaff(user) {
    return Boolean(user && !user.isAnonymous);
}

function isSystemAdmin() {

    const user = firebase.auth().currentUser;

    return isStaff(user) && user.email === SYSTEM_ADMIN_EMAIL;
}

// إظهار أو إخفاء الاستفسارات حسب حالة الدخول
async function handleStaffAuthChange(user) {

    updateAdminView();

    const staffContent =
        document.getElementById("staffContent");

    if (!isStaff(user)) {

        if (stopListening) {
            stopListening();
            stopListening = null;
        }

        if (stopListeningStaff) {
            stopListeningStaff();
            stopListeningStaff = null;
        }

        cachedRecords = [];
        selectedInquiryId = null;

        staffContent.style.display = "none";

        document.getElementById("inquiryDetails")
            .style.display = "none";

        return;
    }

    // التأكد أن الحساب ضمن قائمة الموظفين المضافين
    if (!(await hasStaffAccess(user))) {

        alert("هذا الحساب ليس لديه صلاحية الدخول، تواصل مع مدير النظام");

        await firebase.auth().signOut();
        return;
    }

    staffContent.style.display = "block";

    if (isSystemAdmin()) {
        listenToStaff();
    }

    if (!stopListening) {

        await migrateLocalRecords();

        listenToInquiries();
    }
}

async function adminLogin() {

    const usernameInput =
        document.getElementById("adminUsername");

    const passwordInput =
        document.getElementById("adminPassword");

    const username =
        usernameInput.value.trim().toLowerCase();

    if (!username || !passwordInput.value) {
        alert("يرجى إدخال اسم المستخدم وكلمة المرور");
        return;
    }

    try {

        await initFirebase(false);

        await firebase.auth().signInWithEmailAndPassword(
            // إذا كُتب إيميل كامل يُستخدم كما هو (مدير النظام)
            username.includes("@")
                ? username
                : username + STAFF_EMAIL_DOMAIN,
            passwordInput.value
        );

        usernameInput.value = "";
        passwordInput.value = "";

    } catch (error) {

        console.error("خطأ في تسجيل الدخول:", error);

        alert("اسم المستخدم أو كلمة المرور غير صحيحة");
    }
}

async function adminLogout() {

    try {
        await firebase.auth().signOut();
    } catch (error) {
        console.error(error);
    }
}

function updateAdminView() {

    const user = firebase.auth().currentUser;

    const loggedInStaff = isStaff(user);

    const loginForm =
        document.getElementById("adminLoginForm");

    const loggedIn =
        document.getElementById("adminLoggedIn");

    const deleteButton =
        document.getElementById("deleteButton");

    if (loginForm) {
        loginForm.style.display =
            loggedInStaff ? "none" : "block";
    }

    if (loggedIn) {
        loggedIn.style.display =
            loggedInStaff ? "flex" : "none";
    }

    if (loggedInStaff) {
        document.getElementById("adminLoggedInText")
            .textContent = "تم الدخول باسم: " +
                (isSystemAdmin()
                    ? "مدير النظام"
                    : user.email.replace(STAFF_EMAIL_DOMAIN, ""));
    }

    if (deleteButton) {
        deleteButton.style.display =
            isSystemAdmin() ? "block" : "none";
    }

    const staffManager =
        document.getElementById("staffManager");

    if (staffManager) {
        staffManager.style.display =
            isSystemAdmin() ? "block" : "none";
    }
}


// ==========================================
// 13-ب. إدارة الموظفين (لمدير النظام فقط)
// ==========================================

async function hasStaffAccess(user) {

    if (isSystemAdmin()) {
        return true;
    }

    try {

        const doc = await db.collection(STAFF_COLLECTION)
            .doc(user.email)
            .get();

        return doc.exists;

    } catch (error) {
        // القواعد ترفض القراءة لمن ليس في القائمة
        return false;
    }
}

function listenToStaff() {

    if (stopListeningStaff) {
        return;
    }

    stopListeningStaff = db.collection(STAFF_COLLECTION)
        .onSnapshot(snapshot => {

            const list = document.getElementById("staffList");

            list.innerHTML = "";

            if (snapshot.empty) {

                const item = document.createElement("li");

                item.textContent = "لا يوجد موظفون مضافون حالياً";

                list.appendChild(item);
                return;
            }

            snapshot.docs.forEach(doc => {

                const item = document.createElement("li");

                const name = document.createElement("span");

                name.textContent =
                    doc.data().username ||
                    doc.id.replace(STAFF_EMAIL_DOMAIN, "");

                const removeButton =
                    document.createElement("button");

                removeButton.type = "button";
                removeButton.textContent = "إزالة";

                removeButton.onclick = function () {
                    removeStaff(doc.id, name.textContent);
                };

                item.appendChild(name);
                item.appendChild(removeButton);

                list.appendChild(item);
            });

        }, error => {
            console.error("خطأ في قراءة الموظفين:", error);
        });
}

async function addStaff() {

    const usernameInput =
        document.getElementById("newStaffUsername");

    const passwordInput =
        document.getElementById("newStaffPassword");

    const username =
        usernameInput.value.trim().toLowerCase();

    const password = passwordInput.value;

    if (!/^[a-z0-9._-]+$/.test(username)) {
        alert("اسم المستخدم يكون بالإنجليزي فقط وبدون مسافات (مثال: ahmed)");
        return;
    }

    if (password.length < 6) {
        alert("كلمة المرور يجب أن تكون 6 أحرف على الأقل");
        return;
    }

    const email = username + STAFF_EMAIL_DOMAIN;

    if (email === SYSTEM_ADMIN_EMAIL) {
        alert("لا يمكن استخدام اسم مدير النظام");
        return;
    }

    // نسخة منفصلة من Firebase حتى لا يخرج مدير النظام عند إنشاء الحساب
    const creatorApp =
        firebase.apps.find(app => app.name === "staffCreator") ||
        firebase.initializeApp(FIREBASE_CONFIG, "staffCreator");

    let accountExisted = false;

    try {

        await creatorApp.auth()
            .createUserWithEmailAndPassword(email, password);

        await creatorApp.auth().signOut();

    } catch (error) {

        if (error.code === "auth/email-already-in-use") {
            accountExisted = true;
        } else {
            console.error("خطأ في إنشاء الحساب:", error);
            alert("تعذر إنشاء حساب الموظف");
            return;
        }
    }

    try {

        await db.collection(STAFF_COLLECTION)
            .doc(email)
            .set({
                username: username,
                addedAt: new Date().toISOString()
            });

        usernameInput.value = "";
        passwordInput.value = "";

        alert(
            accountExisted
                ? "تمت إعادة صلاحية الموظف " + username +
                  " (الحساب موجود مسبقاً، وكلمة المرور القديمة لم تتغير)"
                : "تمت إضافة الموظف " + username + " بنجاح"
        );

    } catch (error) {
        console.error("خطأ في إضافة الموظف:", error);
        alert("تعذر إضافة الموظف إلى القائمة");
    }
}

async function removeStaff(email, username) {

    const confirmed = confirm(
        "هل تريدين إزالة صلاحية الموظف " + username + "؟"
    );

    if (!confirmed) {
        return;
    }

    try {

        await db.collection(STAFF_COLLECTION)
            .doc(email)
            .delete();

    } catch (error) {
        console.error(error);
        alert("تعذر إزالة الموظف");
    }
}


// ==========================================
// 14. حذف استفسار محدد (لمدير النظام فقط)
// ==========================================

async function deleteInquiry() {

    if (!selectedInquiryId) {
        alert("يرجى اختيار استفسار أولاً");
        return;
    }

    if (!isSystemAdmin()) {
        alert("الحذف متاح فقط لمدير النظام");
        return;
    }

    const confirmed = confirm(
        "هل أنتِ متأكدة من حذف هذا الاستفسار نهائياً؟"
    );

    if (!confirmed) {
        return;
    }

    try {

        await db.collection(INQUIRIES_COLLECTION)
            .doc(selectedInquiryId)
            .delete();

        selectedInquiryId = null;

        document.getElementById("inquiryDetails")
            .style.display = "none";

        alert("تم حذف الاستفسار بنجاح");

    } catch (error) {
        console.error(error);
        alert("تعذر حذف الاستفسار");
    }
}


// ==========================================
// 15. رمز الدخول للمتعامل (من QR في الإدارة)
// ==========================================

// احتياطي إذا كان المتصفح يمنع sessionStorage
let accessCodeInMemory = "";

function getStoredAccessCode() {

    try {
        return sessionStorage.getItem(ACCESS_CODE_KEY) || "";
    } catch (error) {
        return accessCodeInMemory;
    }
}

function storeAccessCode(code) {

    accessCodeInMemory = code;

    try {
        sessionStorage.setItem(ACCESS_CODE_KEY, code);
    } catch (error) {
        // يكفي الحفظ في الذاكرة
    }
}

function clearStoredAccessCode() {

    accessCodeInMemory = "";

    try {
        sessionStorage.removeItem(ACCESS_CODE_KEY);
    } catch (error) {
        // لا شيء
    }
}

// قراءة الرمز من رابط QR ثم حذفه من شريط العنوان
// حتى لا يُنسخ الرابط مع الرمز بسهولة
function captureAccessCodeFromUrl() {

    const params = new URLSearchParams(location.search);

    const code = (params.get("code") || "").trim().toLowerCase();

    if (/^[a-z0-9]{6,32}$/.test(code)) {
        storeAccessCode(code);
    }

    if (params.has("code")) {
        history.replaceState(null, "", location.pathname);
    }
}

// التأكد أن الرمز ما زال صالحاً قبل إظهار النموذج
async function checkCustomerAccess() {

    const code = getStoredAccessCode();

    if (!code) {
        showAccessBlocked(
            "هذه الصفحة مخصصة لمراجعي الإدارة. يرجى مسح رمز QR الموجود في الإدارة"
        );
        return;
    }

    try {

        const doc = await db.collection(ACCESS_CODES_COLLECTION)
            .doc(code)
            .get();

        const expiresAt =
            doc.exists && doc.data().expiresAt
                ? doc.data().expiresAt.toDate()
                : null;

        if (!expiresAt || expiresAt <= new Date()) {

            clearStoredAccessCode();

            showAccessBlocked(
                "انتهت صلاحية الرمز. يرجى مسح رمز QR الموجود في الإدارة من جديد"
            );
            return;
        }

    } catch (error) {
        // عند انقطاع الاتصال نُظهر النموذج، والسيرفر يتحقق عند الإرسال
        console.error("تعذر التحقق من الرمز:", error);
    }

    document.getElementById("accessChecking").style.display = "none";
    document.getElementById("step1").style.display = "block";
}

function showAccessBlocked(text) {

    document.getElementById("accessChecking").style.display = "none";
    document.getElementById("step1").style.display = "none";
    document.getElementById("step2").style.display = "none";

    const blocked = document.getElementById("accessBlocked");

    document.getElementById("accessBlockedText").textContent = text;

    blocked.style.display = "block";
}


// ==========================================
// 16. شاشة الاستقبال (QR يتغير كل يوم)
// ==========================================

let kioskTimer = null;
let kioskCode = "";

async function handleKioskAuthChange(user) {

    updateAdminView();

    const qrBox = document.getElementById("qrBox");

    if (!isStaff(user) || !(await hasStaffAccess(user))) {

        qrBox.style.display = "none";

        if (kioskTimer) {
            clearInterval(kioskTimer);
            kioskTimer = null;
        }

        kioskCode = "";

        if (isStaff(user)) {

            alert("هذا الحساب ليس لديه صلاحية، تواصل مع مدير النظام");

            await firebase.auth().signOut();
        }

        return;
    }

    qrBox.style.display = "block";

    await refreshKioskCode();

    // التحقق كل دقيقة: إذا انتهى اليوم يُنشأ رمز جديد تلقائياً
    if (!kioskTimer) {
        kioskTimer = setInterval(refreshKioskCode, 60 * 1000);
    }
}

// رمز عشوائي من 10 أحرف وأرقام
function generateAccessCode() {

    const chars = "abcdefghjkmnpqrstuvwxyz23456789";

    const values = new Uint32Array(10);

    crypto.getRandomValues(values);

    return Array.from(values, value =>
        chars[value % chars.length]
    ).join("");
}

// الرمز ينتهي منتصف الليل
function endOfToday() {

    const end = new Date();

    end.setHours(23, 59, 59, 999);

    return end;
}

async function refreshKioskCode() {

    try {

        const now = new Date();

        const snapshot = await db.collection(ACCESS_CODES_COLLECTION)
            .where("expiresAt", ">", now)
            .orderBy("expiresAt", "desc")
            .limit(1)
            .get();

        let code;
        let expiresAt;

        if (snapshot.empty) {

            code = generateAccessCode();
            expiresAt = endOfToday();

            await db.collection(ACCESS_CODES_COLLECTION)
                .doc(code)
                .set({
                    expiresAt: firebase.firestore.Timestamp.fromDate(expiresAt),
                    createdAt: firebase.firestore.Timestamp.fromDate(now)
                });

            deleteExpiredAccessCodes();

        } else {

            code = snapshot.docs[0].id;
            expiresAt = snapshot.docs[0].data().expiresAt.toDate();
        }

        if (code !== kioskCode) {

            kioskCode = code;

            renderKioskQr(code, expiresAt);
        }

        document.getElementById("qrError").textContent = "";

    } catch (error) {

        console.error("خطأ في تحديث رمز QR:", error);

        document.getElementById("qrError").textContent =
            "تعذر تحديث الرمز، تأكد من الاتصال بالإنترنت";
    }
}

function renderKioskQr(code, expiresAt) {

    const url = new URL("./", location.href);

    url.search = "?code=" + code;

    const qrCode = document.getElementById("qrCode");

    qrCode.innerHTML = "";

    new QRCode(qrCode, {
        text: url.toString(),
        width: 320,
        height: 320,
        correctLevel: QRCode.CorrectLevel.M
    });

    document.getElementById("qrExpiry").textContent =
        "صالح حتى نهاية يوم " +
        expiresAt.toLocaleDateString("ar-AE", {
            weekday: "long",
            day: "numeric",
            month: "long"
        });
}

// تنظيف الرموز القديمة من قاعدة البيانات
async function deleteExpiredAccessCodes() {

    try {

        const snapshot = await db.collection(ACCESS_CODES_COLLECTION)
            .where("expiresAt", "<=", new Date())
            .get();

        await Promise.all(
            snapshot.docs.map(doc => doc.ref.delete())
        );

    } catch (error) {
        console.error("تعذر حذف الرموز القديمة:", error);
    }
}
