// Import required modules
import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

// Load environment variables from .env file
dotenv.config();

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware setup
// Enable CORS for all routes to allow frontend to communicate with the backend
app.use(cors());
// Parse incoming JSON requests
app.use(express.json());

// PostgreSQL database connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test the database connection
pool.connect((err, client, release) => {
  if (err) {
    return console.error('Error acquiring client', err.stack);
  }
  client.query('SELECT NOW()', (err, result) => {
    release();
    if (err) {
      return console.error('Error executing query', err.stack);
    }
    console.log('Database connected successfully:', result.rows[0].now);
  });
});

// Function to create the necessary tables in the database
async function createTables() {
  try {
    // Table for managing the QR codes and their usage
    const createQrCodesTable = `
      CREATE TABLE IF NOT EXISTS qr_codes (
        code VARCHAR(8) PRIMARY KEY,
        usage_count INT DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // Table for storing book information
    const createBooksTable = `
      CREATE TABLE IF NOT EXISTS books (
        id SERIAL PRIMARY KEY,
        class VARCHAR(50) NOT NULL,
        subject VARCHAR(100) NOT NULL,
        title VARCHAR(255) NOT NULL,
        price NUMERIC(10, 2) NOT NULL,
        is_book BOOLEAN NOT NULL,
        UNIQUE (class, subject, title)
      );
    `;

    // Table for storing sales entries
    const createSalesEntriesTable = `
      CREATE TABLE IF NOT EXISTS sales_entries (
        id SERIAL PRIMARY KEY,
        student_name VARCHAR(255) NOT NULL,
        class VARCHAR(50) NOT NULL,
        total_amount NUMERIC(10, 2) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        items JSONB NOT NULL
      );
    `;
    
    // Table for admin users
    const createAdminsTable = `
        CREATE TABLE IF NOT EXISTS admins (
            id SERIAL PRIMARY KEY,
            username VARCHAR(255) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;

    await pool.query(createQrCodesTable);
    console.log('qr_codes table created or already exists.');
    await pool.query(createBooksTable);
    console.log('books table created or already exists.');
    await pool.query(createSalesEntriesTable);
    console.log('sales_entries table created or already exists.');
    await pool.query(createAdminsTable);
    console.log('admins table created or already exists.');

  } catch (err) {
    console.error('Error creating tables:', err);
  }
}

// Create tables on application startup
createTables();

// Helper function to generate a random 8-character string
const generateRandomCode = () => {
    return crypto.randomBytes(4).toString('hex').slice(0, 8);
};

// Middleware to authenticate JWTs
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401); // If no token, unauthorized

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            console.error('JWT verification error:', err);
            return res.sendStatus(403); // If token is not valid, forbidden
        }
        req.user = user;
        next();
    });
};

// API Route for admin registration (unauthenticated)
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required.' });
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', [username, hashedPassword]);
        res.status(201).json({ message: 'Admin registered successfully.' });
    } catch (err) {
        console.error('Error during registration:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// API Route for admin login (unauthenticated)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
        const admin = result.rows[0];
        if (!admin) {
            return res.status(401).json({ message: 'Invalid username or password.' });
        }
        const isMatch = await bcrypt.compare(password, admin.password_hash);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid username or password.' });
        }
        const token = jwt.sign({ id: admin.id, username: admin.username }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.json({ token });
    } catch (err) {
        console.error('Error during login:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// API Route to generate a new QR code link (protected)
app.post('/generate-qr-code', authenticateToken, async (req, res) => {
    try {
        const code = generateRandomCode();
        // Insert the new unique code into the database
        const result = await pool.query(
            'INSERT INTO qr_codes (code) VALUES ($1) RETURNING *',
            [code]
        );
        // Assuming the portal URL is defined as an environment variable
        const portalUrl = process.env.PORTAL_URL;
        if (!portalUrl) {
            return res.status(500).json({ message: 'PORTAL_URL environment variable is not set.' });
        }
        const fullUrl = `${portalUrl}/?code=${code}`;

        res.status(201).json({
            message: 'QR code generated successfully.',
            code,
            url: fullUrl
        });
    } catch (err) {
        console.error('Error generating QR code:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// New API route to get all books and stationery
app.get('/books', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM books ORDER BY class, subject, title');
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching books:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// New API route to submit a sales entry
app.post('/submit-sale', async (req, res) => {
    const { qr_code, student_name, student_class, items, total_amount } = req.body;

    if (!qr_code || !student_name || !student_class || !items || !total_amount) {
        return res.status(400).json({ message: 'Missing required fields.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if the QR code exists and hasn't been used more than once
        const qrCodeResult = await client.query('SELECT usage_count FROM qr_codes WHERE code = $1', [qr_code]);
        if (qrCodeResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Invalid QR code.' });
        }
        const usageCount = qrCodeResult.rows[0].usage_count;
        if (usageCount >= 1) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'This QR code has already been used.' });
        }

        // Insert the sales entry
        await client.query(
            'INSERT INTO sales_entries (student_name, class, total_amount, items) VALUES ($1, $2, $3, $4)',
            [student_name, student_class, total_amount, JSON.parse(items)]
        );

        // Update the QR code usage count
        await client.query('UPDATE qr_codes SET usage_count = usage_count + 1 WHERE code = $1', [qr_code]);

        await client.query('COMMIT');
        res.status(201).json({ message: 'Sale submitted successfully.' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error submitting sale:', err);
        res.status(500).json({ message: 'Internal server error.' });
    } finally {
        client.release();
    }
});

// New API route to get the full sales report (protected)
app.get('/sales-report', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sales_entries ORDER BY created_at DESC');
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching sales report:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// New API route to get a single sales entry by ID (protected)
app.get('/sales/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM sales_entries WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Sales entry not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching single sales entry:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// New API route to get the QR code usage report (protected)
app.get('/qr-report', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM qr_codes ORDER BY created_at DESC');
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching QR code report:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// Other API Routes will be defined here in subsequent steps
app.get('/', (req, res) => {
  res.send('Book Sales Portal Backend is running!');
});

// Start the server
app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});

// Export the pool for use in other modules
export { pool };
