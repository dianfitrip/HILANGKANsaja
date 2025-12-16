const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const app = express();
const port = 3000;

require('dotenv').config();

// --- 1. KONEKSI DATABASE ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
});

db.connect((err) => {
    if (err) {
        console.error('Gagal koneksi ke database:', err);
    } else {
        console.log('Berhasil terhubung ke Database MySQL...');
    }
});

// --- 2. MIDDLEWARE ---
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// Konfigurasi Upload Foto
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/images/uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// --- 3. DATA DUMMY ---
const categories = [
    { id: 1, name: 'Elektronik (HP, Laptop, Kamera)' },
    { id: 2, name: 'Dokumen (KTP, KTM, SIM, STNK)' },
    { id: 3, name: 'Dompet/Tas' },
    { id: 4, name: 'Kunci/Aksesoris' },
    { id: 5, name: 'Pakaian/Sepatu' },
    { id: 6, name: 'Lainnya' }
];

// --- 4. ROUTES HALAMAN ---
app.get('/', (req, res) => { res.render('home', { activePage: 'home' }); });
app.get('/prosedur', (req, res) => { res.render('prosedur', { activePage: 'prosedur' }); });

app.get('/form-penemuan', (req, res) => {
    res.render('form-penemuan', { categories: categories });
});

app.get('/form-kehilangan', (req, res) => {
    res.render('form-kehilangan', { categories: categories });
});

// --- 5. API: KIRIM OTP ---
app.post('/api/send-otp', (req, res) => {
    const { email } = req.body;
    if (!email) return res.json({ success: false, message: 'Email tidak boleh kosong.' });

    const otpCode = Math.floor(100000 + Math.random() * 900000);
    const query = `INSERT INTO verification_codes (email, otp_code, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))`;

    db.query(query, [email, otpCode], (err, result) => {
        if (err) {
            console.error(err);
            return res.json({ success: false, message: 'Database Error' });
        }
        console.log(`OTP untuk ${email}: ${otpCode}`); 
        res.json({ success: true, message: 'Kode OTP terkirim!', debug_otp: otpCode });
    });
});

app.post('/api/verify-otp', (req, res) => {
    const { email, otp_code } = req.body;
    if (!email || !otp_code) return res.json({ success: false, message: 'Email dan Kode OTP wajib diisi.' });

    const query = `SELECT * FROM verification_codes WHERE email = ? AND otp_code = ? AND expires_at > NOW()`;
    db.query(query, [email, otp_code], (err, results) => {
        if (err) return res.json({ success: false, message: 'Database Error' });
        if (results.length > 0) res.json({ success: true, message: 'Kode Valid!' });
        else res.json({ success: false, message: 'Kode Salah atau sudah Kadaluarsa.' });
    });
});

// --- FUNGSI VALIDASI BACKEND (SUPER LENGKAP) ---
function validateRequest(data, file) {
    // 1. Cek Field Wajib (General) - Return 'field' name agar frontend tahu mana yang merah
    if (!data.reporter_name) return { field: 'reporter_name', message: "Nama wajib diisi." };
    if (!data.category_id) return { field: 'category_id', message: "Pilih kategori barang." };
    if (!data.item_name) return { field: 'item_name', message: "Nama barang wajib diisi." };
    if (!data.description) return { field: 'description', message: "Deskripsi wajib diisi." };
    if (!data.date_event) return { field: 'date_event', message: "Tanggal wajib diisi." };
    if (!data.location) return { field: 'location', message: "Lokasi wajib diisi." };
    if (!data.reporter_email) return { field: 'reporter_email', message: "Email wajib diisi." };
    if (!data.otp_code) return { field: 'otp_code', message: "Kode OTP wajib diisi." };

    // 2. Validasi Identitas Spesifik
    const idNum = data.identification_number;
    const len = idNum ? idNum.length : 0;
    
    if (!idNum) return { field: 'identification_number', message: "Nomor identitas wajib diisi." };

    if (data.reporter_status === 'mahasiswa') {
        if (len !== 11) return { field: 'identification_number', message: "NIM Mahasiswa wajib 11 digit angka!" };
    } 
    else if (data.reporter_status === 'lainnya') {
        if (len !== 16) return { field: 'identification_number', message: "NIK KTP wajib 16 digit angka!" };
    }
    else if (data.reporter_status === 'dosen' || data.reporter_status === 'tendik') {
        if (len < 5 || len > 20) return { field: 'identification_number', message: "NIP/NIK Pegawai tidak valid." };
    }
    else if (data.reporter_status === 'foreign_student') {
        if (len < 5) return { field: 'identification_number', message: "Passport Number terlalu pendek." };
    }

    return null; // Lolos Validasi
}

// --- 6. API: SUBMIT FORM PENEMUAN ---
app.post('/submit-penemuan', upload.single('item_image'), (req, res) => {
    const data = req.body;
    const file = req.file;

    // 1. Validasi Input Dasar & Identitas
    const validationError = validateRequest(data, file);
    if (validationError) return res.json({ success: false, ...validationError });

    // 2. Cek OTP
    const checkOtpQuery = `SELECT * FROM verification_codes WHERE email = ? AND otp_code = ? AND expires_at > NOW()`;
    db.query(checkOtpQuery, [data.reporter_email, data.otp_code], (err, results) => {
        if (err) return res.json({ success: false, field: 'general', message: "Database Error saat verifikasi OTP." });

        if (results.length === 0) {
            return res.json({ success: false, field: 'otp_code', message: "Kode OTP salah atau sudah kadaluarsa!" });
        }

        const imagePath = file ? '/images/uploads/' + file.filename : null;
        const accessToken = Math.random().toString(36).substring(7);
        
        const insertReportQuery = `INSERT INTO reports (category_id, type, status, reporter_name, reporter_status, identification_number, reporter_contact, item_name, description, location, date_event, image_path, access_token) VALUES (?, 'found', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const values = [data.category_id, data.reporter_name, data.reporter_status, data.identification_number, data.reporter_email, data.item_name, data.description, data.location, data.date_event, imagePath, accessToken];

        db.query(insertReportQuery, values, (err, result) => {
            if (err) return res.json({ success: false, field: 'general', message: "Gagal menyimpan laporan." });
            res.json({ success: true, message: "Laporan Penemuan Berhasil Disimpan!" });
        });
    });
});

// --- 7. API: SUBMIT FORM KEHILANGAN ---
app.post('/submit-kehilangan', upload.single('item_image'), (req, res) => {
    const data = req.body;
    const file = req.file;

    const validationError = validateRequest(data, file);
    if (validationError) return res.json({ success: false, ...validationError });

    const checkOtpQuery = `SELECT * FROM verification_codes WHERE email = ? AND otp_code = ? AND expires_at > NOW()`;
    db.query(checkOtpQuery, [data.reporter_email, data.otp_code], (err, results) => {
        if (err) return res.json({ success: false, field: 'general', message: "Database Error saat verifikasi OTP." });

        if (results.length === 0) {
            return res.json({ success: false, field: 'otp_code', message: "Kode OTP salah atau sudah kadaluarsa!" });
        }

        const imagePath = file ? '/images/uploads/' + file.filename : null;
        const accessToken = Math.random().toString(36).substring(7);

        const insertReportQuery = `INSERT INTO reports (category_id, type, status, reporter_name, reporter_status, identification_number, reporter_contact, item_name, description, location, date_event, image_path, access_token) VALUES (?, 'lost', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const values = [data.category_id, data.reporter_name, data.reporter_status, data.identification_number, data.reporter_email, data.item_name, data.description, data.location, data.date_event, imagePath, accessToken];

        db.query(insertReportQuery, values, (err, result) => {
            if (err) return res.json({ success: false, field: 'general', message: "Gagal menyimpan laporan." });
            res.json({ success: true, message: "Laporan Kehilangan Berhasil Disimpan!" });
        });
    });
});

// --- 8. LIST BARANG TEMUAN ---
app.get('/list-barang-temuan', (req, res) => {
    const searchQuery = req.query.search || '';
    const categoryFilter = req.query.category || '';
    let sql = `SELECT reports.*, categories.name AS category_name FROM reports LEFT JOIN categories ON reports.category_id = categories.id WHERE reports.type = 'found' AND reports.status != 'rejected'`;
    const queryParams = [];

    if (searchQuery) { sql += ` AND reports.item_name LIKE ?`; queryParams.push(`%${searchQuery}%`); }
    if (categoryFilter) { sql += ` AND reports.category_id = ?`; queryParams.push(categoryFilter); }
    sql += ` ORDER BY reports.date_event DESC, reports.created_at DESC`;

    db.query(sql, queryParams, (err, results) => {
        if (err) return res.send('Database Error');
        res.render('list-barang-temuan', { activePage: 'list-barang-temuan', reports: results, categories: categories, searchQuery: searchQuery, categoryFilter: categoryFilter });
    });
});

app.listen(port, () => { console.log(`Web berjalan di http://localhost:${port}`); });