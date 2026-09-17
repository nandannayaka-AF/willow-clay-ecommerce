require('dotenv').config();

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');

const app = express();

const PORT = 3000;

// ===========================================================
// SUPABASE
// ===========================================================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY;

app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

const orderAttempts = new Map();
function limitOrderAttempts(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const recent = (orderAttempts.get(key) || []).filter(function (time) {
    return now - time < windowMs;
  });

  if (recent.length >= 10) {
    return res.status(429).json({
      error: 'Too many order attempts. Please wait a few minutes and try again.'
    });
  }

  recent.push(now);
  orderAttempts.set(key, recent);
  next();
}

// The anonymous key is intentionally safe to expose to the browser. The
// secret key above remains server-only and is never sent to clients.
app.get('/api/auth/config', function (req, res) {
  if (!supabaseAnonKey) {
    return res.status(500).json({ error: 'Authentication is not configured.' });
  }

  res.json({
    url: process.env.SUPABASE_URL,
    anonKey: supabaseAnonKey
  });
});

async function requireAdmin(req, res, next) {
  const authorization = req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: 'Please sign in.' });
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);

  if (userError || !userData.user) {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileError || !profile || profile.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access is required.' });
  }

  req.user = userData.user;
  next();
}

// Returns the signed-in user's role. Accounts without a profile are regular
// customers by default; only an explicit admin role unlocks admin endpoints.
app.get('/api/auth/me', async function (req, res) {
  const authorization = req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: 'Please sign in.' });
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);

  if (userError || !userData.user) {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileError) {
    console.error('Could not load user profile:', profileError);
    return res.status(500).json({ error: 'Could not load account details.' });
  }

  res.json({
    email: userData.user.email,
    role: profile && profile.role === 'admin' ? 'admin' : 'customer'
  });
});

app.get('/api/account/orders', async function (req, res) {
  const authorization = req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: 'Please sign in.' });
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user || !userData.user.email) {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }

  const { data, error } = await supabase
    .from('orders')
    .select(`
      id,
      placed_at,
      order_items (
        quantity,
        price,
        products ( name )
      )
    `)
    .eq('email', userData.user.email)
    .order('placed_at', { ascending: false });

  if (error) {
    console.error('Could not load customer orders:', error);
    return res.status(500).json({ error: 'Could not load your orders.' });
  }

  res.json(data);
});

function productPayload(body) {
  const price = Number(body.price);
  const stock = Number(body.stock);

  const textFields = [body.name, body.description, body.category];
  const hasMarkup = textFields.some(function (value) {
    return typeof value === 'string' && /[<>]/.test(value);
  });
  const imageIsSafe = typeof body.img === 'string' &&
    (/^(https?:\/\/|\/|\.\/|images\/)/i.test(body.img.trim()));

  if (
    typeof body.name !== 'string' || !body.name.trim() ||
    !imageIsSafe ||
    typeof body.description !== 'string' ||
    typeof body.category !== 'string' ||
    hasMarkup ||
    body.name.length > 120 || body.description.length > 2000 ||
    body.category.length > 80 || body.img.length > 2000 ||
    !Number.isFinite(price) || price < 0 ||
    !Number.isInteger(stock) || stock < 0
  ) {
    return null;
  }

  return {
    name: body.name.trim(),
    price: price,
    img: body.img.trim(),
    description: body.description.trim(),
    category: body.category.trim(),
    stock: stock
  };
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    const next = csv[index + 1];

    if (character === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(value.trim());
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(value.trim());
      if (row.some(function (cell) { return cell !== ''; })) rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }

  if (quoted) throw new Error('CSV contains an unclosed quote.');
  row.push(value.trim());
  if (row.some(function (cell) { return cell !== ''; })) rows.push(row);
  return rows;
}


// ===========================================================
// TEST DATABASE CONNECTION
// ===========================================================

app.get('/api/test-db', async function (req, res) {

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .limit(1);

  if (error) {
    console.error('Supabase error:', error);

    return res.status(500).json({
      error: error.message
    });
  }

  res.json({
    connected: true,
    data: data
  });
});


// ===========================================================
// CREATE ORDER
// ===========================================================

app.post('/api/orders', limitOrderAttempts, async function (req, res) {

  const order = req.body;

  if (
    !order.name ||
    !order.email ||
    !order.address ||
    !order.items ||
    order.items.length === 0
  ) {

    return res.status(400).json({
      error: 'Missing order details.'
    });
  }

  if (
    typeof order.name !== 'string' || order.name.length > 120 ||
    typeof order.email !== 'string' || order.email.length > 254 ||
    typeof order.address !== 'string' || order.address.length > 500 ||
    order.items.length > 50
  ) {
    return res.status(400).json({ error: 'Order details are too long or contain too many items.' });
  }

  const items = order.items.map(function (item) {
    return {
      id: Number(item.id),
      quantity: Number(item.quantity)
    };
  });

  if (items.some(function (item) {
    return !Number.isInteger(item.id) ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1;
  })) {
    return res.status(400).json({
      error: 'Order items must have a valid product and quantity.'
    });
  }

  try {

    // Validation, stock changes, and inserts run atomically in PostgreSQL.
    const { data: result, error } = await supabase.rpc(
      'create_order_with_stock',
      {
        p_name: order.name,
        p_email: order.email,
        p_address: order.address,
        p_items: items
      }
    );

    if (error) {
      if (error.code === 'P0001') {
        return res.status(400).json({ error: error.message });
      }

      throw error;
    }

    // -------------------------------------------------------
    // 4. Terminal confirmation
    // -------------------------------------------------------

    console.log('New order saved to Supabase:', {
      orderId: result.order_id,
      name: order.name,
      email: order.email,
      items: items
    });


    // -------------------------------------------------------
    // 5. Send response to browser
    // -------------------------------------------------------

    res.status(201).json({
      success: true,
      orderId: result.order_id
    });

  } catch (error) {

    console.error('Could not save order:', error);

    res.status(500).json({
      error: 'Could not save order.'
    });

  }

});


// ===========================================================
// PRODUCTS API — NOW FROM SUPABASE
// ===========================================================

app.get('/api/products', async function (req, res) {

  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('id', { ascending: true });

  if (error) {

    console.error('Could not load products:', error);

    return res.status(500).json({
      error: 'Could not load products.'
    });
  }

  res.json(data);

});

// ===========================================================
// ADMIN PRODUCTS — requires a signed-in user with profiles.role = 'admin'
// ===========================================================

app.get('/api/admin/products', requireAdmin, async function (req, res) {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('id', { ascending: true });

  if (error) {
    console.error('Could not load admin products:', error);
    return res.status(500).json({ error: 'Could not load products.' });
  }

  res.json(data);
});

app.post('/api/admin/products', requireAdmin, async function (req, res) {
  const product = productPayload(req.body);

  if (!product) {
    return res.status(400).json({ error: 'Enter valid product details and a non-negative whole-number stock value.' });
  }

  const { data, error } = await supabase
    .from('products')
    .insert(product)
    .select()
    .single();

  if (error) {
    console.error('Could not create product:', error);
    return res.status(500).json({ error: 'Could not create product.' });
  }

  res.status(201).json(data);
});

app.post('/api/admin/products/import', requireAdmin, async function (req, res) {
  if (typeof req.body.csv !== 'string' || req.body.csv.length > 500000) {
    return res.status(400).json({ error: 'Upload a CSV file smaller than 500 KB.' });
  }

  let rows;
  try {
    rows = parseCsv(req.body.csv);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const header = rows.shift() || [];
  const required = ['name', 'price', 'stock', 'img', 'category', 'description'];
  const normalizedHeader = header.map(function (column) {
    return column.trim().toLowerCase();
  });

  if (required.some(function (column) { return !normalizedHeader.includes(column); })) {
    return res.status(400).json({
      error: 'CSV header must include: name, price, stock, img, category, description.'
    });
  }

  if (!rows.length || rows.length > 100) {
    return res.status(400).json({ error: 'CSV must contain between 1 and 100 products.' });
  }

  const products = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const values = Object.fromEntries(normalizedHeader.map(function (column, columnIndex) {
      return [column, row[columnIndex] || ''];
    }));
    const product = productPayload(values);
    if (!product) {
      return res.status(400).json({ error: `Invalid product data on CSV line ${index + 2}.` });
    }
    products.push(product);
  }

  const { data, error } = await supabase
    .from('products')
    .insert(products)
    .select();

  if (error) {
    console.error('Could not import products:', error);
    return res.status(500).json({ error: 'Could not import products. No products were added.' });
  }

  res.status(201).json({ imported: data.length });
});

app.post('/api/admin/product-images', requireAdmin, async function (req, res) {
  const image = req.body && req.body.image;
  const match = typeof image === 'string' && image.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);

  if (!match) {
    return res.status(400).json({ error: 'Choose a JPG, PNG, WEBP, or GIF image.' });
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 3 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image must be 3 MB or smaller.' });
  }

  const extension = match[1].split('/')[1] === 'jpeg' ? 'jpg' : match[1].split('/')[1];
  const path = `${randomUUID()}.${extension}`;
  const { error } = await supabase.storage
    .from('product-images')
    .upload(path, buffer, { contentType: match[1], upsert: false });

  if (error) {
    console.error('Could not upload product image:', error);
    return res.status(500).json({ error: 'Could not upload image. Ensure the product-images Storage bucket exists.' });
  }

  const { data } = supabase.storage.from('product-images').getPublicUrl(path);
  res.status(201).json({ url: data.publicUrl });
});

app.put('/api/admin/products/:id', requireAdmin, async function (req, res) {
  const id = Number(req.params.id);
  const product = productPayload(req.body);

  if (!Number.isInteger(id) || !product) {
    return res.status(400).json({ error: 'Enter valid product details.' });
  }

  const { data, error } = await supabase
    .from('products')
    .update(product)
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) {
    console.error('Could not update product:', error);
    return res.status(500).json({ error: 'Could not update product.' });
  }

  if (!data) {
    return res.status(404).json({ error: 'Product not found.' });
  }

  res.json(data);
});

app.delete('/api/admin/products/:id', requireAdmin, async function (req, res) {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid product ID.' });
  }

  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', id);

  if (error) {
    // Existing order items normally protect the product with a foreign key.
    if (error.code === '23503') {
      return res.status(409).json({
        error: 'This product belongs to an existing order and cannot be deleted.'
      });
    }

    console.error('Could not delete product:', error);
    return res.status(500).json({ error: 'Could not delete product.' });
  }

  res.status(204).end();
});

app.get('/api/admin/dashboard', requireAdmin, async function (req, res) {
  const [productsResult, ordersResult, itemsResult] = await Promise.all([
    supabase.from('products').select('id, stock'),
    supabase.from('orders').select('id', { count: 'exact', head: true }),
    supabase.from('order_items').select('quantity, price')
  ]);

  if (productsResult.error || ordersResult.error || itemsResult.error) {
    console.error('Could not load dashboard:', {
      products: productsResult.error,
      orders: ordersResult.error,
      items: itemsResult.error
    });
    return res.status(500).json({ error: 'Could not load dashboard statistics.' });
  }

  const products = productsResult.data || [];
  const totalSales = (itemsResult.data || []).reduce(function (total, item) {
    return total + Number(item.price) * Number(item.quantity);
  }, 0);

  res.json({
    totalProducts: products.length,
    totalOrders: ordersResult.count || 0,
    lowStockProducts: products.filter(function (product) {
      return product.stock > 0 && product.stock <= 5;
    }).length,
    outOfStockProducts: products.filter(function (product) {
      return product.stock === 0;
    }).length,
    totalSales: totalSales
  });
});
// ===========================================================
// ADMIN ORDERS
// ===========================================================

app.get('/api/admin/orders', requireAdmin, async function (req, res) {

  const { data, error } = await supabase
    .from('orders')
    .select(`
      id,
      name,
      email,
      address,
      placed_at,
      order_items (
        id,
        product_id,
        quantity,
        price,
        products (
          name
        )
      )
    `)
    .order('placed_at', { ascending: false });

  if (error) {
    console.error('Could not load admin orders:', error);

    return res.status(500).json({
      error: 'Could not load orders.'
    });
  }

  res.json(data);
});


// ===========================================================
// SERVE WEBSITE FILES
// ===========================================================

app.use(express.static(__dirname));


// ===========================================================
// START SERVER
// ===========================================================

app.listen(PORT, function () {

  console.log(
    `Server running at http://localhost:${PORT}`
  );

});
