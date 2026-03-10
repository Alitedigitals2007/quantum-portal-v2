require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const session = require('express-session');
const app = express();
const csv = require('csv-parser');
const fs = require('fs');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    // 💡 Essential for Neon + High Latency areas
    connectionTimeoutMillis: 30000, // 30 seconds (gives Neon time to wake up)
    idleTimeoutMillis: 60000,       // Keep the connection alive for 1 minute
    max: 10                         // Max connections
});

app.set('view engine', 'ejs');
app.use(express.static('public'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'quantum_squad_key',
    resave: false,
    saveUninitialized: false, // Changed to false for better security
    cookie: { secure: false } // Set to true only if using HTTPS
}));

// --- ROUTES ---

// 1. Home Page - Pulls "Latest Announcements" from the database
app.get('/', async (req, res) => {
  try {
    // For now, we'll use a simple array for announcements
    const announcements = [
      { title: "PHY301 Test", date: "March 14" },
      { title: "Assignment Deadline", date: "March 17" }
    ];
    res.render('home', { announcements });
  } catch (err) {
    res.status(500).send("Database Error");
  }
});

// 1. GET LOGIN PAGE
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

// 2. POST LOGIN LOGIC
app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    // 🛡️ ADMIN LOGIN CHECK (Hardcoded or from 'admins' table)
    const ADMIN_ID = "123400";
    const ADMIN_PASS = "ayomide2007";

    try {
        // 1. Check if it's the Admin entering
        if (username === ADMIN_ID && password === ADMIN_PASS) {
            req.session.user = {
                name: "Atilola Israel",
                role: "SUPER_ADMIN", // This role flag is vital
                matric: "ADMIN-001",
                level: "ROOT"
            };
            return res.redirect('/admin/dashboard');
        }

        // 2. Otherwise, check the Students table in the DB
        const result = await pool.query('SELECT * FROM students WHERE matric_no = $1', [username]);

        if (result.rows.length > 0) {
            const student = result.rows[0];

            if (password === student.password) {
                req.session.user = {
                    name: student.full_name,
                    matric: student.matric_no,
                    level: student.level,
                    cgpa: student.current_cgpa,
                    semester: student.semester,
                    role: "STUDENT"
                };
                return res.redirect('/dashboard');
            } else {
                return res.render('login', { error: 'Invalid Password' });
            }
        } else {
            return res.render('login', { error: 'Access Denied' });
        }
    } catch (err) {
        console.error(err);
        res.render('login', { error: 'Database Sync Error' });
    }
});

// 🛠️ ADMIN DASHBOARD ROUTE (The missing piece)
app.get('/admin/dashboard', async (req, res) => {
    // 1. Security Check
    if (!req.session.user || req.session.user.role !== 'SUPER_ADMIN') {
        return res.redirect('/login');
    }

    try {
        // 2. Try to get real numbers
        // Wrap each query in a try/catch or use COALESCE to prevent crashes
        const studentRes = await pool.query('SELECT COUNT(*) FROM students').catch(() => ({ rows: [{ count: 0 }] }));
        const courseRes = await pool.query('SELECT COUNT(*) FROM courses').catch(() => ({ rows: [{ count: 0 }] }));
        const materialRes = await pool.query('SELECT COUNT(*) FROM materials').catch(() => ({ rows: [{ count: 0 }] }));
        const announceRes = await pool.query('SELECT COUNT(*) FROM announcements').catch(() => ({ rows: [{ count: 0 }] }));

        const stats = {
            totalStudents: studentRes.rows[0].count,
            totalCourses: courseRes.rows[0].count,
            totalMaterials: materialRes.rows[0].count,
            totalAnnouncements: announceRes.rows[0].count
        };

        // 3. Render the page
        res.render('admin_dashboard', { 
            user: req.session.user, 
            stats: stats 
        });

    } catch (err) {
        console.error("Critical Dashboard Error:", err);
        // If everything fails, show zeros so the UI at least opens
        res.render('admin_dashboard', { 
            user: req.session.user, 
            stats: { totalStudents: 0, totalCourses: 0, totalMaterials: 0, totalAnnouncements: 0 } 
        });
    }
});

app.get('/dashboard', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    // Pass the session user to the dashboard view
    res.render('dashboard', { user: req.session.user });
});

app.get('/dashboard', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const today = new Date().toLocaleDateString('en-GB', { weekday: 'long' }); // e.g. "Monday"

    try {
        // 1. Fetch Today's Classes
        const timetableRes = await pool.query(
            'SELECT * FROM timetable WHERE day_of_week = $1 AND level = $2 ORDER BY start_time ASC', 
            [today, req.session.user.level]
        );

        // 2. Fetch Global Rank
        const rankRes = await pool.query(`
            SELECT rank FROM (
                SELECT matric_no, RANK() OVER (ORDER BY current_cgpa DESC) as rank
                FROM students
            ) as ranking WHERE matric_no = $1`, [req.session.user.matric]);

        res.render('dashboard', { 
            user: req.session.user, 
            timetable: timetableRes.rows,
            rank: rankRes.rows[0].rank 
        });
    } catch (err) {
        console.error(err);
        res.render('dashboard', { user: req.session.user, timetable: [], rank: 'N/A' });
    }
});

// 🛰️ LOGOUT ROUTE
app.get('/logout', (req, res) => {
    // This clears the 'user' data from the session
    req.session.destroy((err) => {
        if (err) {
            console.error("Logout Error:", err);
            return res.redirect('/dashboard');
        }
        // Once session is killed, clear the cookie and go home
        res.clearCookie('connect.sid'); 
        res.redirect('/login');
    });
});


// --- SECURITY MIDDLEWARE ---
// This stops students from typing /admin/dashboard in the URL
const isAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'SUPER_ADMIN') {
        next();
    } else {
        res.status(403).send("⚠️ Access Denied: Root Privileges Required.");
    }
};


// Protected Admin Dashboard Route
app.get('/admin/dashboard', async (req, res) => {
    // 🛡️ Security Check
    if (!req.session.user || req.session.user.role !== 'SUPER_ADMIN') {
        return res.redirect('/login');
    }

    try {
        // 📊 Fetching real-time stats from Neon PostgreSQL
        // We use Promise.all to run all queries at the same time (faster)
        const [studentRes, courseRes, materialRes, announceRes] = await Promise.all([
            pool.query('SELECT COUNT(*) FROM students'),
            pool.query('SELECT COUNT(*) FROM courses'),
            pool.query('SELECT COUNT(*) FROM materials'), // Make sure this table exists
            pool.query('SELECT COUNT(*) FROM announcements') // Make sure this table exists
        ]);

        // 📦 Packaging the data to send to EJS
        const stats = {
            totalStudents: studentRes.rows[0].count,
            totalCourses: courseRes.rows[0].count,
            totalMaterials: materialRes.rows[0].count,
            totalAnnouncements: announceRes.rows[0].count
        };

        res.render('admin_dashboard', { 
            user: req.session.user, 
            stats: stats 
        });

    } catch (err) {
        console.error("Database Error:", err);
        // Fallback so the page doesn't crash if a table is missing
        res.render('admin_dashboard', { 
            user: req.session.user, 
            stats: { totalStudents: 0, totalCourses: 0, totalMaterials: 0, totalAnnouncements: 0 } 
        });
    }
});

// --- CONSOLIDATED STUDENT MANAGEMENT ROUTE ---
app.get('/admin/students', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM students ORDER BY full_name ASC');
        res.render('admin_students', { students: result.rows, user: req.session.user });
    } catch (err) {
        res.status(500).send("Database Timeout");
    }
});

// --- ADD / EDIT STUDENT ---
app.post('/admin/students/save', async (req, res) => {
    const { full_name, matric_no, email, level, password, cgpa, isEdit } = req.body;
    try {
        if (isEdit === "true") {
            await pool.query(
                'UPDATE students SET full_name=$1, email=$2, level=$3, password=$4, current_cgpa=$5 WHERE matric_no=$6',
                [full_name, email, level, password, cgpa, matric_no]
            );
        } else {
            await pool.query(
                'INSERT INTO students (full_name, matric_no, email, level, password, current_cgpa) VALUES ($1, $2, $3, $4, $5, $6)',
                [full_name, matric_no, email, level, password, cgpa]
            );
        }
        res.redirect('/admin/students');
    } catch (err) {
        res.status(500).send("Error saving student. Matric No must be unique.");
    }
});

// --- DELETE STUDENT (Query Param Method) ---
app.get('/admin/students/delete', async (req, res) => {
    const { matric } = req.query; 
    try {
        await pool.query('DELETE FROM students WHERE matric_no = $1', [matric]);
        res.redirect('/admin/students');
    } catch (err) {
        res.status(500).send("Delete failed.");
    }
});

// --- BULK UPLOAD ---
app.post('/admin/students/bulk', upload.single('csvFile'), (req, res) => {
    const rows = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            for (const row of rows) {
                await pool.query(
                    `INSERT INTO students (full_name, matric_no, email, level, password, current_cgpa) 
                     VALUES ($1, $2, $3, $4, $5, $6) 
                     ON CONFLICT (matric_no) DO UPDATE SET current_cgpa = EXCLUDED.current_cgpa`,
                    [row.full_name, row.matric_no, row.email, row.level, row.password, row.cgpa || 0]
                );
            }
            fs.unlinkSync(req.file.path);
            res.redirect('/admin/students');
        });
});

// --- GET ALL COURSES ---
app.get('/admin/courses', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'SUPER_ADMIN') return res.redirect('/login');
    try {
        const result = await pool.query('SELECT * FROM courses ORDER BY course_code ASC');
        res.render('admin_courses', { 
            courses: result.rows, 
            user: req.session.user 
        });
    } catch (err) {
        res.status(500).send("Database Error");
    }
});

app.post('/admin/courses/save', async (req, res) => {
    // 1. Get data from the form
    const { course_code, course_title, lecturer, units, isEdit } = req.body;
    
    try {
        // 2. Check the 'isEdit' flag carefully
        if (isEdit === "true" || isEdit === true) {
            
            // EXECUTE UPDATE: Find the course by its code and change other details
            await pool.query(
                'UPDATE courses SET course_title=$1, lecturer_name=$2, units=$3 WHERE course_code=$4',
                [course_title, lecturer, units, course_code]
            );
            console.log(`Updated: ${course_code}`);

        } else {
            
            // EXECUTE INSERT: Create a brand new record
            await pool.query(
                'INSERT INTO courses (course_code, course_title, lecturer_name, units) VALUES ($1, $2, $3, $4)',
                [course_code, course_title, lecturer, units]
            );
            console.log(`Added: ${course_code}`);
        }

        res.redirect('/admin/courses');

    } catch (err) {
        console.error("Database Error:", err.message);
        
        // If it's a "Unique Violation" error from Postgres
        if (err.code === '23505') {
            res.status(400).send(`Error: The code "${course_code}" is already assigned to another course.`);
        } else {
            res.status(500).send("Database Error: " + err.message);
        }
    }
});

// --- DELETE COURSE ROUTE ---
app.get('/admin/courses/delete', async (req, res) => {
    // 🛡️ Security: Only admins can delete
    if (!req.session.user || req.session.user.role !== 'SUPER_ADMIN') {
        return res.redirect('/login');
    }

    const { code } = req.query; // Gets the code from ?code=...

    try {
        await pool.query('DELETE FROM courses WHERE course_code = $1', [code]);
        res.redirect('/admin/courses'); // Go back to the list
    } catch (err) {
        console.error("Delete Error:", err);
        res.status(500).send("Failed to delete the course. Check your database connection.");
    }
});

// --- BULK CSV UPLOAD ---
app.post('/admin/courses/bulk', upload.single('csvFile'), (req, res) => {
    const rows = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            try {
                for (const r of rows) {
                    await pool.query(
                        `INSERT INTO courses (course_code, course_title, lecturer_name, units) 
                         VALUES ($1, $2, $3, $4) 
                         ON CONFLICT (course_code) DO UPDATE SET lecturer_name = EXCLUDED.lecturer_name`,
                        [r.course_code, r.course_title, r.lecturer, r.units || 2]
                    );
                }
                fs.unlinkSync(req.file.path);
                res.redirect('/admin/courses');
            } catch (err) {
                res.status(500).send("Bulk upload failed.");
            }
        });
});

// --- GET TIMETABLE PAGE ---
app.get('/admin/timetable', async (req, res) => {
    try {
        const courses = await pool.query('SELECT course_code, course_title FROM courses');
        const venues = await pool.query('SELECT * FROM venues ORDER BY name ASC');
        const timetable = await pool.query('SELECT * FROM timetable');
        
        // Define our standard time blocks
        const timeSlots = ["8:00 - 9:00", "9:00 - 10:00", "10:00 - 11:00", "11:00 - 12:00", "12:00 - 1:00", "1:00 - 2:00", "2:00 - 3:00", "3:00 - 4:00", "4:00 - 5:00"];
        const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

        res.render('admin_timetable', { 
            courses: courses.rows, 
            venues: venues.rows, 
            timetable: timetable.rows,
            timeSlots,
            days,
            user: req.session.user 
        });
    } catch (err) {
        res.status(500).send("Error loading timetable data.");
    }
});

// --- SAVE TIMETABLE SLOT ---
app.post('/admin/timetable/save', async (req, res) => {
    const { day, time, course, venue } = req.body;
    try {
        await pool.query(
            `INSERT INTO timetable (day_of_week, time_slot, course_code, venue_name) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (day_of_week, time_slot) 
             DO UPDATE SET course_code = EXCLUDED.course_code, venue_name = EXCLUDED.venue_name`,
            [day, time, course, venue]
        );
        res.redirect('/admin/timetable');
    } catch (err) {
        res.status(500).send("Scheduling Error: " + err.message);
    }
});

// --- ADD NEW VENUE ---
app.post('/admin/venues/add', async (req, res) => {
    try {
        await pool.query('INSERT INTO venues (name) VALUES ($1) ON CONFLICT DO NOTHING', [req.body.venue_name]);
        res.redirect('/admin/timetable');
    } catch (err) {
        res.redirect('/admin/timetable');
    }
});
// Updated Helper for UI 4.0 point scale
const calculateGP = (score) => {
    if (score >= 70) return { grade: 'A', gp: 4.0 };
    if (score >= 60) return { grade: 'B', gp: 3.0 };
    if (score >= 50) return { grade: 'C', gp: 2.0 };
    if (score >= 45) return { grade: 'D', gp: 1.0 };
    return { grade: 'F', gp: 0.0 }; // No 'E' in standard 4.0 scale
};
app.get('/admin/results', async (req, res) => {
    // 1. Check if user is logged in
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const students = await pool.query('SELECT matric_no, full_name FROM students ORDER BY full_name');
        const courses = await pool.query('SELECT course_code, units FROM courses');
        const results = await pool.query(`
            SELECT r.*, s.full_name, c.course_title 
            FROM results r 
            JOIN students s ON r.student_matric = s.matric_no 
            JOIN courses c ON r.course_code = c.course_code
            ORDER BY r.id DESC
        `);

        // 2. PASS THE USER OBJECT HERE!
        res.render('admin_results', { 
            students: students.rows, 
            courses: courses.rows, 
            results: results.rows,
            user: req.session.user  // <--- ADD THIS LINE
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching results.");
    }
});
app.post('/admin/results/save', async (req, res) => {
    let { student_matric, course_code, test_score, exam_score, total_score, session, semester } = req.body;

    // Convert to numbers or default to 0
    let test = parseInt(test_score) || 0;
    let exam = parseInt(exam_score) || 0;
    
    // If you typed a "Total" manually in the form, use it. 
    // Otherwise, sum the test and exam.
    let finalTotal = parseInt(total_score) || (test + exam);

    // Calculate Grade/GP on the finalTotal
    const { grade, gp } = calculateGP(finalTotal);

    try {
        await pool.query(
            `INSERT INTO results (student_matric, course_code, test_score, exam_score, score, grade, gp, academic_session, semester) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (student_matric, course_code, academic_session) 
             DO UPDATE SET test_score = EXCLUDED.test_score, exam_score = EXCLUDED.exam_score, score = EXCLUDED.score, grade = EXCLUDED.grade, gp = EXCLUDED.gp`,
            [student_matric, course_code, test, exam, finalTotal, grade, gp, session, semester]
        );
        res.redirect('/admin/results');
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});
// --- BULK RESULTS UPLOAD ---
app.post('/admin/results/bulk', upload.single('csvFile'), (req, res) => {
    const rows = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            try {
                for (const r of rows) {
                    const test = parseInt(r.test_score) || 0;
                    const exam = parseInt(r.exam_score) || 0;
                    const total = test + exam;
                    
                    // Calculate Grade and GP based on TOTAL only
                    const { grade, gp } = calculateGP(total);

                    await pool.query(
                        `INSERT INTO results (student_matric, course_code, test_score, exam_score, score, grade, gp, academic_session, semester) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
                         ON CONFLICT (student_matric, course_code, academic_session) 
                         DO UPDATE SET test_score = EXCLUDED.test_score, exam_score = EXCLUDED.exam_score, score = EXCLUDED.score, grade = EXCLUDED.grade, gp = EXCLUDED.gp`,
                        [r.matric, r.course_code, test, exam, total, grade, gp, r.session, r.semester]
                    );
                }
                fs.unlinkSync(req.file.path);
                res.redirect('/admin/results');
            } catch (err) {
                console.error(err);
                res.status(500).send("Bulk upload failed.");
            }
        });
});
app.get('/admin/materials', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    try {
        // 1. Fetch courses from your database
        const coursesResult = await pool.query('SELECT course_code, course_title FROM courses ORDER BY course_code ASC');
        
        // 2. Fetch the materials
        const materialsResult = await pool.query(`
            SELECT m.*, c.course_title 
            FROM materials m 
            JOIN courses c ON m.course_code = c.course_code 
            ORDER BY m.id DESC
        `);

        // 3. PASS THEM BOTH to the EJS
        res.render('admin_materials', { 
            courses: coursesResult.rows,    // This must match your EJS loop
            materials: materialsResult.rows,
            user: req.session.user 
        });
    } catch (err) {
        console.error("Database Error:", err);
        res.status(500).send("Internal Server Error");
    }
});
// --- SAVE DRIVE LINK ---
app.post('/admin/materials/add-link', async (req, res) => {
    const { course_code, title, drive_link } = req.body;

    try {
        await pool.query(
            'INSERT INTO materials (course_code, title, drive_link) VALUES ($1, $2, $3)',
            [course_code, title, drive_link]
        );
        res.redirect('/admin/materials');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error saving drive link.");
    }
});

// 2. GET Route: View Announcements
app.get('/admin/announcements', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    try {
        const result = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC');
        res.render('admin_announcements', { 
            announcements: result.rows, 
            user: req.session.user 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading announcements.");
    }
});

// 3. POST Route: Add Announcement
// FIX: You must call .fields([...]) and provide the array of field names
app.post('/admin/announcements/add', upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'attachment', maxCount: 1 }
]), async (req, res) => {
    
    // Check if files exist before trying to access them to prevent crashes
    const image_url = (req.files && req.files['image']) ? '/uploads/announcements/' + req.files['image'][0].filename : null;
    const file_url = (req.files && req.files['attachment']) ? '/uploads/announcements/' + req.files['attachment'][0].filename : null;

    try {
        await pool.query(
            'INSERT INTO announcements (title, content, image_url, file_url, external_link) VALUES ($1, $2, $3, $4, $5)',
            [req.body.title, req.body.content, image_url, file_url, req.body.external_link]
        );
        res.redirect('/admin/announcements');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error saving announcement.");
    }
});
app.get('/timetable', async (req, res) => {
    try {
        // This query ensures we get the LATEST entry for every specific time/day combo
        // to prevent "double courses" in one cell.
        const query = `
            SELECT DISTINCT ON (t.day_of_week, t.time_slot)
                t.day_of_week, 
                t.time_slot, 
                t.venue_name, 
                t.course_code,
                c.course_title, 
                c.lecturer 
            FROM timetable t
            LEFT JOIN courses c ON t.course_code = c.course_code
            ORDER BY t.day_of_week, t.time_slot, t.id DESC
        `;
        const result = await pool.query(query);
        
        res.render('timetable', { 
            timetable: result.rows, 
            user: req.session.user || null 
        });
    } catch (err) {
        console.error("Timetable Sync Error:", err);
        res.status(500).send("Error loading data.");
    }
});
// 1. View all courses
app.get('/courses', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM courses ORDER BY course_code ASC');
        res.render('courses', { 
            courses: result.rows, 
            user: req.session.user || null 
        });
    } catch (err) {
        console.error("Error fetching courses:", err);
        res.status(500).send("Database Error");
    }
});

// 2. Add a new course (POST)
// Add a new course (Updated for Units)
app.post('/add-course', async (req, res) => {
    const { course_code, course_title, lecturer, units } = req.body;
    try {
        await pool.query(
            'INSERT INTO courses (course_code, course_title, lecturer, units) VALUES ($1, $2, $3, $4)',
            [course_code, course_title, lecturer, units]
        );
        res.redirect('/courses');
    } catch (err) {
        console.error("Error adding course:", err);
        res.status(500).send("Error saving course. Check if code is unique.");
    }
});
app.get('/materials', async (req, res) => {
    try {
        const materialsRes = await pool.query('SELECT * FROM materials ORDER BY upload_date DESC');
        // Fetch valid courses to populate the dropdown
        const coursesRes = await pool.query('SELECT course_code FROM courses ORDER BY course_code ASC');
        
        res.render('materials', { 
            materials: materialsRes.rows, 
            courseList: coursesRes.rows, // Pass this to the EJS
            user: req.session.user || null 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database Error");
    }
});
app.get('/results', async (req, res) => {
    try {
        // This query joins results with courses to get titles and units for GPA calculation
        const query = `
            SELECT r.*, c.course_title, c.units 
            FROM results r
            JOIN courses c ON r.course_code = c.course_code
            ORDER BY c.course_code ASC
        `;
        const result = await pool.query(query);
        
        res.render('results', { 
            results: result.rows, 
            user: req.session.user || null 
        });
    } catch (err) {
        console.error("Error fetching results:", err);
        res.status(500).send("Database Error: Make sure your 'results' table exists.");
    }
});
// REPLACE LINE 716 WITH THIS:
app.post('/upload-material', async (req, res) => {
    const { course_code, title, drive_link } = req.body;
    
    try {
        // We use the confirmed columns: course_code, title, drive_link
        await pool.query(
            'INSERT INTO materials (course_code, title, drive_link, upload_date) VALUES ($1, $2, $3, NOW())',
            [course_code.toUpperCase(), title, drive_link]
        );
        res.redirect('/materials');
    } catch (err) {
        console.error("Upload Error:", err);
        res.status(500).send("Database Error: Check if the course code exists in the courses table.");
    }
});

app.listen(3000, () => console.log('Portal live at http://localhost:3000'));