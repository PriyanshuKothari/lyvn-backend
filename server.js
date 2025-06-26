const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const Shopify = require('shopify-api-node');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ dest: 'uploads/' });

// Serve uploaded images statically
app.use('/uploads', express.static('uploads'));

// Shopify Setup
const shopify = new Shopify({
  shopName: process.env.SHOPIFY_SHOP_NAME,
  apiKey: process.env.SHOPIFY_API_KEY,
  password: process.env.SHOPIFY_ACCESS_TOKEN
});

// Gemini AI Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Database Setup
const db = new sqlite3.Database('lyvn.db', (err) => {
  if (err) {
    console.error('Database error:', err);
    process.exit(1);
  }
  db.run(`CREATE TABLE IF NOT EXISTS designs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    description TEXT,
    image_url TEXT,
    user_id INTEGER,
    votes INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE
  )`);
});

// GiftGenie Endpoint
app.post('/giftgenie', async (req, res) => {
  try {
    const { relationship, vibe, budget, message } = req.body;
    if (!relationship || !vibe || !budget) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const products = await shopify.product.list({ limit: 5, tags: vibe });
    const suggestions = products
      .filter(p => p.variants[0].price <= parseInt(budget))
      .map(p => ({
        title: p.title,
        url: p.online_store_url,
        image: p.images[0]?.src || ''
      }));
    let generatedMessage = message;
    if (!message) {
      const prompt = `Write a short gift message for a ${relationship} with a ${vibe} vibe.`;
      const result = await model.generateContent(prompt);
      generatedMessage = result.response.text();
    }
    res.json({ suggestions, message: generatedMessage });
  } catch (err) {
    console.error('GiftGenie error:', err);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// TeeLab Upload Endpoint
app.post('/teelab', upload.single('design'), async (req, res) => {
  try {
    const { title, desc, user_id } = req.body;
    if (!title || !desc || !req.file) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const image_url = `/uploads/${req.file.filename}`;
    db.run(
      `INSERT INTO designs (title, description, image_url, user_id, votes) VALUES (?, ?, ?, ?, 0)`,
      [title, desc, image_url, user_id],
      (err) => {
        if (err) {
          console.error('TeeLab upload error:', err);
          return res.status(400).json({ error: 'Upload failed' });
        }
        res.json({ success: 'Design uploaded' });
      }
    );
  } catch (err) {
    console.error('TeeLab upload error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// TeeLab Like Endpoint
app.post('/like/:id', (req, res) => {
  try {
    db.run(`UPDATE designs SET votes = votes + 1 WHERE id = ?`, [req.params.id], (err) => {
      if (err) {
        console.error('Like error:', err);
        return res.status(400).json({ error: 'Like failed' });
      }
      res.json({ success: 'Liked' });
    });
  } catch (err) {
    console.error('Like error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// TeeLab Gallery Endpoint
app.get('/teelab/designs', (req, res) => {
  try {
    db.all(`SELECT * FROM designs ORDER BY votes DESC`, (err, rows) => {
      if (err) {
        console.error('Gallery error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(rows);
    });
  } catch (err) {
    console.error('Gallery error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Style Suggester Endpoint
app.post('/stylesuggest', async (req, res) => {
  try {
    const { gender, skin_tone, body_type } = req.body;
    if (!gender || !skin_tone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const tags = `${gender},${skin_tone}${body_type ? ',' + body_type : ''}`;
    const products = await shopify.product.list({ limit: 5, tags });
    const suggestions = products.map(p => ({
      title: p.title,
      url: p.online_store_url,
      image: p.images[0]?.src || ''
    }));
    res.json({ suggestions });
  } catch (err) {
    console.error('Style Suggester error:', err);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// Home Signup Endpoint
app.post('/signup', (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }
    db.run(`INSERT OR IGNORE INTO signups (email) VALUES (?)`, [email], (err) => {
      if (err) {
        console.error('Signup error:', err);
        return res.status(400).json({ error: 'Signup failed' });
      }
      res.json({ success: 'Signed up' });
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));