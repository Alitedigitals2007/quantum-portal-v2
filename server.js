require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const session = require('express-session');
const app = express();
const csv = require('csv-parser');
const fs = require('fs');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // or your direct string
    ssl: {
        rejectUnauthorized: false 
    }
});


const multer = require('multer');
const storage = multer.memoryStorage(); // 👈 This uses RAM, not a folder!
const upload = multer({ storage: storage });
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

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    const ADMIN_ID = "123400";
    const ADMIN_PASS = "ayomide2007";

    try {
        // 1. ADMIN CHECK
        if (username === ADMIN_ID && password === ADMIN_PASS) {
            req.session.userId = 999; // Give admin a dummy ID
            req.session.user = {
                id: 999,
                name: "Atilola Israel",
                role: "SUPER_ADMIN"
            };
            // Always save before redirecting
            return req.session.save(() => res.redirect('/admin/dashboard'));
        }

        // 2. STUDENT CHECK
        const result = await pool.query('SELECT * FROM students WHERE matric_no = $1', [username]);

        if (result.rows.length > 0) {
            const student = result.rows[0];

            if (password === student.password) {
                // IMPORTANT: Set these so the /enroll-course route finds them!
                req.session.userId = student.id; 
                req.session.user = {
                    id: student.id,
                    name: student.full_name,
                    matric: student.matric_no,
                    role: "STUDENT"
                };
if (password === student.password) {
    req.session.userId = student.id; 
    req.session.user = {
        id: student.id,
        name: student.full_name,
        matric: student.matric_no,
        // CHECK THIS LINE: Ensure it matches your DB column name
        cgpa: student.current_cgpa, 
        level: student.level,
        role: "STUDENT"
    };

    return req.session.save(() => res.redirect('/dashboard'));
}
                // FORCE SAVE to prevent the "Login Required" error on next page
                return req.session.save((err) => {
                    if (err) console.error("Session Save Error:", err);
                    res.redirect('/dashboard');
                });

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

app.get('/dashboard', async (req, res) => {
    // 1. Session Guard
    if (!req.session || !req.session.user) {
        return res.redirect('/login'); 
    }

    try {
        const studentId = req.session.user.id;
        const studentMatric = req.session.user.matric;

        // 2. Fetch everything from the students table in one go
        const studentData = await pool.query(
            `SELECT 
                current_cgpa, 
                total_units_passed, 
                total_registered_units, 
                full_name AS name 
             FROM students WHERE id = $1`, 
            [studentId]
        );
        
        const student = studentData.rows[0];
        if (!student) return res.redirect('/login');

        // 3. Logic Setup
        const baseCGPA = parseFloat(student.current_cgpa) || 0;
        const baseUnits = parseInt(student.total_units_passed) || 0;
        const registeredUnits = parseInt(student.total_registered_units) || 0; // The "Registered" column
        const basePoints = baseCGPA * baseUnits;

        // 4. Fetch "New" Results (To update the live CGPA)
        const newResults = await pool.query(`
            SELECT 
                SUM(c.unit) AS added_units,
                SUM(r.gp * c.unit) AS added_points,
                COUNT(r.id) AS course_count
            FROM results r
            JOIN courses c ON r.course_code = c.course_code
            WHERE r.student_matric = $1`, [studentMatric]);

        const newRow = newResults.rows[0];
        const addedUnits = parseInt(newRow.added_units) || 0;
        const addedPoints = parseFloat(newRow.added_points) || 0;

        // 5. Weighted Calculation
        const finalUnits = baseUnits + addedUnits;
        const finalPoints = basePoints + addedPoints;
        
        const liveCGPA = finalUnits > 0 
            ? (finalPoints / finalUnits).toFixed(2) 
            : baseCGPA.toFixed(2);

        // 6. Send to EJS
        res.render('dashboard', { 
            user: student, 
            stats: { 
                cgpa: liveCGPA, 
                units: finalUnits,      // This shows as "Passed"
                workload: registeredUnits, // This shows as "Registered" (from your table)
                count: parseInt(newRow.course_count) || 0 
            } 
        });

    } catch (err) {
        console.error("Dashboard Engine Error:", err.message);
        res.status(500).send("Critical System Error. Check Server Logs.");
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
app.post('/admin/students/bulk', upload.single('csvFile'), async (req, res) => {
    if (!req.file) return res.status(400).send("No file uploaded.");

    const rows = [];
    const { Readable } = require('stream'); 

    // 1. Convert the buffer to a stream
    const studentStream = Readable.from(req.file.buffer);

    // 2. Start piping (Note: No semicolon at the end of the line below)
    studentStream
        .pipe(csv())
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            try {
                for (const row of rows) {
                    await pool.query(
                        `INSERT INTO students (full_name, matric_no, email, level, password, current_cgpa) 
                         VALUES ($1, $2, $3, $4, $5, $6) 
                         ON CONFLICT (matric_no) DO UPDATE SET current_cgpa = EXCLUDED.current_cgpa`,
                        [row.full_name, row.matric_no, row.email, row.level, row.password, row.cgpa || 0]
                    );
                }
                // ✅ Removed fs.unlinkSync because memory storage doesn't create a physical file
                res.redirect('/admin/students?success=true');
            } catch (err) {
                console.error("Database Error during bulk upload:", err);
                res.status(500).send("Error saving students to database.");
            }
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
    // 1. Get ALL data including course_type
    const { course_code, course_title, lecturer, units, course_type, isEdit } = req.body;
    
    try {
        if (isEdit === "true" || isEdit === true) {
            // EXECUTE UPDATE: Now includes course_type
            await pool.query(
                'UPDATE courses SET course_title=$1, lecturer_name=$2, units=$3, course_type=$4 WHERE course_code=$5',
                [course_title, lecturer, units, course_type, course_code]
            );
            console.log(`Updated: ${course_code}`);
        } else {
            // EXECUTE INSERT: Now includes course_type
            await pool.query(
                'INSERT INTO courses (course_code, course_title, lecturer_name, units, course_type) VALUES ($1, $2, $3, $4, $5)',
                [course_code.toUpperCase(), course_title, lecturer, units, course_type]
            );
            console.log(`Added: ${course_code}`);
        }

        res.redirect('/admin/courses');

    } catch (err) {
        console.error("Database Error:", err.message);
        
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
app.post('/admin/courses/bulk', upload.single('csvFile'), async (req, res) => {
    if (!req.file) return res.status(400).send("No file uploaded.");

    const rows = [];
    const { Readable } = require('stream'); 

    // 1. Create stream from buffer (NO semicolon at the end of this line)
    const courseStream = Readable.from(req.file.buffer)
        .pipe(csv())
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            try {
                for (const r of rows) {
                    await pool.query(
                        `INSERT INTO courses (course_code, course_title, lecturer_name, units, course_type) 
                         VALUES ($1, $2, $3, $4, $5) 
                         ON CONFLICT (course_code) 
                         DO UPDATE SET 
                            course_title = EXCLUDED.course_title,
                            lecturer_name = EXCLUDED.lecturer_name,
                            units = EXCLUDED.units,
                            course_type = EXCLUDED.course_type`,
                        [
                            r.course_code.toUpperCase().trim(), 
                            r.course_title, 
                            r.lecturer || r.lecturer_name, 
                            r.units || 2,
                            r.course_type || 'Compulsory' // Defaults to Compulsory if column is missing in CSV
                        ]
                    );
                }
                // ✅ No fs.unlinkSync needed for memory storage
                res.redirect('/admin/courses?success=true');
            } catch (err) {
                console.error("Bulk upload error:", err);
                res.status(500).send("Bulk upload failed: " + err.message);
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

app.get('/admin/timetable/delete', async (req, res) => {
    const { day, time } = req.query;
    try {
        await pool.query(
            "DELETE FROM timetable WHERE day_of_week = $1 AND time_slot = $2", 
            [day, time]
        );
        res.redirect('/admin/timetable'); // Refresh the page
    } catch (err) {
        console.error(err);
        res.status(500).send("Error clearing slot");
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
    
    // Calculate final score
    let finalTotal = parseInt(total_score) || (test + exam);

    // Calculate Grade/GP
    const { grade, gp } = calculateGP(finalTotal);

    try {
        await pool.query(
            `INSERT INTO results (
                student_matric, course_code, test_score, exam_score, 
                score, grade, gp, academic_session, semester
            ) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             -- MUST MATCH THE EXACT COLUMNS IN YOUR UNIQUE CONSTRAINT --
             ON CONFLICT (student_matric, course_code, academic_session, semester) 
             DO UPDATE SET 
                test_score = EXCLUDED.test_score, 
                exam_score = EXCLUDED.exam_score, 
                score = EXCLUDED.score, 
                grade = EXCLUDED.grade, 
                gp = EXCLUDED.gp`,
            [student_matric, course_code, test, exam, finalTotal, grade, gp, session, semester]
        );
        res.redirect('/admin/results');
    } catch (err) {
        console.error(err);
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
                    
                    // Calculate Grade and GP
                    const { grade, gp } = calculateGP(total);

                    await pool.query(
                        `INSERT INTO results (
                            student_matric, course_code, test_score, exam_score, 
                            score, grade, gp, academic_session, semester
                        ) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
                         -- UPDATED TO MATCH YOUR 4-COLUMN UNIQUE CONSTRAINT --
                         ON CONFLICT (student_matric, course_code, academic_session, semester) 
                         DO UPDATE SET 
                            test_score = EXCLUDED.test_score, 
                            exam_score = EXCLUDED.exam_score, 
                            score = EXCLUDED.score, 
                            grade = EXCLUDED.grade, 
                            gp = EXCLUDED.gp`,
                        [r.matric, r.course_code, test, exam, total, grade, gp, r.session, r.semester]
                    );
                }
                
                // Cleanup file after processing
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                res.redirect('/admin/results?success=Bulk upload completed');
            } catch (err) {
                console.error("Bulk Upload Error:", err);
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                res.status(500).send("Bulk upload failed: " + err.message);
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
async function autoRegisterCompulsory(studentId) {
    try {
        // Find all Compulsory/Required codes
        const compulsory = await db.query(
            "SELECT course_code FROM courses WHERE course_type IN ('Compulsory', 'Required')"
        );

        // Map them into a query that inserts all at once
        for (let course of compulsory.rows) {
            await db.query(
                `INSERT INTO enrollments (student_id, course_code, is_auto_locked) 
                 VALUES ($1, $2, true) 
                 ON CONFLICT (student_id, course_code) DO NOTHING`, 
                [studentId, course.course_code]
            );
        }
        console.log(`Auto-enrolled student ${studentId} in compulsory courses.`);
    } catch (err) {
        console.error("Auto-registration failed:", err);
    }
}
app.get('/courses', async (req, res) => {
    // 1. Ensure user is logged in
    if (!req.session.user) return res.redirect('/login');
    
    const studentId = req.session.user.id;

    try {
        // 2. We use LEFT JOIN so we see EVERY course, even if not enrolled
        const query = `
            SELECT c.*, 
            CASE WHEN e.student_id IS NOT NULL THEN 1 ELSE 0 END as is_enrolled
            FROM courses c
            LEFT JOIN enrollments e ON c.course_code = e.course_code AND e.student_id = $1
            ORDER BY c.course_code ASC`;

        // FIX: Changed 'db.query' to 'pool.query'
        const result = await pool.query(query, [studentId]);
        
        res.render('courses', { 
            courses: result.rows,
            user: req.session.user
        });
    } catch (err) {
        console.error("Error fetching courses:", err.message);
        res.status(500).send("Database Error");
    }
});

app.post('/add-course', async (req, res) => {
    const { course_code, course_title, units, lecturer, course_type } = req.body;
    try {
        await pool.query(
            `INSERT INTO courses (course_code, course_title, units, lecturer, course_type) 
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (course_code) DO UPDATE 
             SET course_title = $2, units = $3, lecturer = $4, course_type = $5`,
            [course_code.toUpperCase(), course_title, units, lecturer, course_type]
        );
        res.redirect('/courses');
    } catch (err) {
        console.error("Save Error:", err);
        res.status(500).send("Make sure your database has the 'course_type' column!");
    }
});

app.post('/enroll-course/:code', async (req, res) => {
    const courseCode = req.params.code;
    const { action } = req.body;
    
    // Ensure this matches how you store ID in login (usually req.session.user.id)
    const studentId = req.session.user ? req.session.user.id : null; 

    if (!studentId) {
        return res.json({ success: false, message: "Please log in first" });
    }

    try {
        if (action === 'add') {
            // FIX 1: Changed 'db' to 'pool'
            // FIX 2: Use Postgres '$1' placeholders
            // FIX 3: Use 'ON CONFLICT DO NOTHING' for Postgres
            await pool.query(
                "INSERT INTO enrollments (student_id, course_code) VALUES ($1, $2) ON CONFLICT DO NOTHING", 
                [studentId, courseCode]
            );
        } else {
            // FIX 1: Changed 'db' to 'pool'
            // FIX 2: Use Postgres '$1' placeholders
            await pool.query(
                "DELETE FROM enrollments WHERE student_id = $1 AND course_code = $2", 
                [studentId, courseCode]
            );
        }
        res.json({ success: true });
    } catch (err) {
        console.error("Enrollment Error:", err.message);
        res.status(500).json({ success: false, message: "Database Error" });
    }
});

app.get('/my-registered-courses', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    const studentId = req.session.user.id;

    try {
        const query = `
            SELECT c.*, e.is_auto_locked 
            FROM courses c
            JOIN enrollments e ON c.course_code = e.course_code
            WHERE e.student_id = $1
            ORDER BY c.course_code ASC`;

        const result = await db.query(query, [studentId]);
        res.render('my_registered_courses', { courses: result.rows });
    } catch (err) {
        console.error("Error fetching registered courses:", err);
        res.status(500).send("Database Error");
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


app.get('/profile', (req, res) => {
    // Check if user is logged in
    if (!req.session.user) {
        return res.redirect('/login');
    }

    // Pass the user object to the EJS template
    res.render('profile', { 
        user: req.session.user 
    });
});

app.listen(3000, () => console.log('Portal live at http://localhost:3000'));