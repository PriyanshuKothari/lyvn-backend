const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
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

// Validate Shopify credentials
const shopifyConfig = {
  shopName: process.env.SHOPIFY_SHOP_NAME,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN
};

if (!shopifyConfig.shopName || !shopifyConfig.accessToken) {
  console.error('Error: Missing Shopify configuration. Check environment variables:');
  console.error(`SHOPIFY_SHOP_NAME: ${shopifyConfig.shopName || 'Missing'}`);
  console.error(`SHOPIFY_ACCESS_TOKEN: ${shopifyConfig.accessToken ? 'Set' : 'Missing'}`);
  process.exit(1);
}

const shopify = new Shopify(shopifyConfig);

// Gemini AI Setup
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('Error: GEMINI_API_KEY is missing');
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// PostgreSQL Setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS designs (
        id SERIAL PRIMARY KEY,
        title TEXT,
        description TEXT,
        image_url TEXT,
        user_id INTEGER,
        votes INTEGER DEFAULT 0
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS signups (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE
      )
    `);
    console.log('Connected to PostgreSQL database');
    client.release();
  } catch (err) {
    console.error('Database error:', err);
    process.exit(1);
  }
})();

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
        url: p.online_store_url || `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/products/${p.handle}`,
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
    console.error('GiftGenie error:', err.message);
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
    await pool.query(
      'INSERT INTO designs (title, description, image_url, user_id, votes) VALUES ($1, $2, $3, $4, 0)',
      [title, desc, image_url, user_id]
    );
    res.json({ success: 'Design uploaded' });
  } catch (err) {
    console.error('TeeLab upload error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// TeeLab Like Endpoint
app.post('/like/:id', async (req, res) => {
  try {
    await pool.query('UPDATE designs SET votes = votes + 1 WHERE id = $1', [req.params.id]);
    res.json({ success: 'Liked' });
  } catch (err) {
    console.error('Like error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// TeeLab Gallery Endpoint
app.get('/teelab/designs', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM designs ORDER BY votes DESC');
    res.json(result.rows);
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
      url: p.online_store_url || `https://${process.env.SHOPIFY_SHOP_NAME}.myshopify.com/products/${p.handle}`,
      image: p.images[0]?.src || ''
    }));
    res.json({ suggestions });
  } catch (err) {
    console.error('Style Suggester error:', err.message);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// Home Signup Endpoint
app.post('/signup', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }
    await pool.query('INSERT INTO signups (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email]);
    res.json({ success: 'Signed up' });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
