require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const express = require('express');
const {
  InvalidWebhookSignatureError,
  MercadoPagoConfig,
  Payment,
  Preference,
  WebhookSignatureValidator,
} = require('mercadopago');

const app = express();
const port = Number(process.env.PORT || 8000);
const accessToken = cleanEnv(process.env.MERCADO_PAGO_ACCESS_TOKEN);
const webhookSecret = cleanEnv(process.env.MERCADO_PAGO_WEBHOOK_SECRET);
const businessName = cleanEnv(process.env.BUSINESS_NAME) || 'RIFAS E BONUS LTDA';
const dataDir = path.join(__dirname, 'data');
const stateFile = path.join(dataDir, 'raffle-state.json');
const importedJoseOrder = {
  id: 'imported-jose-edvaldo-lote',
  name: 'Jose Edvaldo da Silva Costa',
  phone: 'Compra importada do Pix',
  email: '',
  numbers: [
    '0172', '0338', '0700', '0791', '0813', '1138', '1323', '1508', '1527', '1712',
    '1905', '1925', '2349', '2366', '2520', '2635', '2820', '2911', '3130', '3255',
    '4160', '4205', '4275', '4336', '4713', '4728', '4761', '5005', '5218', '5235',
    '5417', '5545', '5598', '5879', '5953', '5975', '5983', '6414', '6482', '6509',
    '6591', '7063', '7267', '7490', '7613', '7760', '7770', '7807', '7829',
  ],
  status: 'paid',
  createdAt: '2026-06-15T21:36:00.000Z',
  mercadoPagoStatus: 'approved',
  imported: true,
};

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mercadoPagoConfigured: Boolean(accessToken),
    webhookSecretConfigured: Boolean(webhookSecret),
    accessTokenPrefix: accessToken ? accessToken.slice(0, 8) : '',
    accessTokenLength: accessToken.length,
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || '',
  });
});

app.get('/api/state', (_req, res) => {
  res.json(loadState());
});

app.put('/api/state', (req, res) => {
  const nextState = normalizeState(req.body || {});
  saveState(nextState);
  res.json(nextState);
});

app.post('/api/orders', (req, res) => {
  const order = normalizeOrder(req.body || {});
  if (!order.id) {
    res.status(400).json({ error: 'Pedido invalido: id obrigatorio.' });
    return;
  }

  const state = loadState();
  const index = state.orders.findIndex((item) => item.id === order.id);
  if (index >= 0) {
    state.orders[index] = mergeOrder(state.orders[index], order);
  } else {
    state.orders.push(order);
  }

  saveState(state);
  res.status(201).json(order);
});

app.patch('/api/orders/:id', (req, res) => {
  const state = loadState();
  const order = state.orders.find((item) => item.id === req.params.id);

  if (!order) {
    res.status(404).json({ error: 'Compra nao encontrada.' });
    return;
  }

  const { status, mercadoPagoStatus } = req.body || {};
  if (status) order.status = status;
  if (mercadoPagoStatus) order.mercadoPagoStatus = mercadoPagoStatus;
  order.updatedAt = new Date().toISOString();

  saveState(state);
  res.json(order);
});

app.delete('/api/orders/:id', (req, res) => {
  const state = loadState();
  const lengthBefore = state.orders.length;
  state.orders = state.orders.filter((item) => item.id !== req.params.id);

  if (state.orders.length === lengthBefore) {
    res.status(404).json({ error: 'Compra nao encontrada.' });
    return;
  }

  saveState(state);
  res.status(204).end();
});

app.post('/api/create-pix', async (req, res) => {
  if (!accessToken) {
    res.status(500).json({
      error: 'MERCADO_PAGO_ACCESS_TOKEN nao configurado no arquivo .env.',
    });
    return;
  }

  const { amount, buyer, numbers, orderId } = req.body || {};
  const normalizedAmount = Number(amount);

  if (!normalizedAmount || normalizedAmount <= 0) {
    res.status(400).json({ error: 'Valor invalido para gerar Pix.' });
    return;
  }

  if (!buyer?.name || !buyer?.email) {
    res.status(400).json({ error: 'Nome e e-mail sao obrigatorios para gerar Pix.' });
    return;
  }

  const idempotencyKey = orderId || crypto.randomUUID();

  try {
    const response = await createPixPayment({
      amount: normalizedAmount,
      buyer,
      numbers,
      idempotencyKey,
    });

    const transactionData = response.point_of_interaction?.transaction_data || {};
    res.json({
      id: response.id,
      status: response.status,
      orderId: idempotencyKey,
      qrCode: transactionData.qr_code,
      qrCodeBase64: transactionData.qr_code_base64,
      ticketUrl: transactionData.ticket_url,
    });
  } catch (error) {
    res.status(502).json({
      error: 'Nao foi possivel criar o Pix no Mercado Pago.',
      detail: error?.message || String(error),
    });
  }
});

app.post('/api/create-preference', async (req, res) => {
  if (!accessToken) {
    res.status(500).json({
      error: 'MERCADO_PAGO_ACCESS_TOKEN nao configurado no arquivo .env.',
    });
    return;
  }

  const { amount = 0.25, quantity = 1, buyer, numbers, orderId } = req.body || {};
  const normalizedAmount = Number(amount);
  const normalizedQuantity = Math.max(Number(quantity) || 1, 1);

  if (!normalizedAmount || normalizedAmount <= 0) {
    res.status(400).json({ error: 'Valor invalido para criar preferencia.' });
    return;
  }

  const client = new MercadoPagoConfig({
    accessToken,
    options: { timeout: 10000 },
  });
  const preference = new Preference(client);
  const externalReference = orderId || crypto.randomUUID();

  try {
    const response = await preference.create({
      body: compactObject({
        items: [
          {
            id: 'rifa-bicicleta',
            title: `${businessName} - Rifa Bicicleta nova zero`,
            description: Array.isArray(numbers) && numbers.length ? `Numeros: ${numbers.join(', ')}` : 'Numeros da rifa',
            quantity: normalizedQuantity,
            unit_price: normalizedAmount,
            currency_id: 'BRL',
          },
        ],
        payer: buyer?.email
          ? compactObject({
              name: buyer.name,
              email: buyer.email,
              phone: parsePhone(buyer.phone),
            })
          : undefined,
        external_reference: externalReference,
        notification_url: process.env.MERCADO_PAGO_WEBHOOK_URL,
        metadata: {
          rifa: 'bicicleta-nova-zero',
          numbers: Array.isArray(numbers) ? numbers.join(',') : '',
          buyer_phone: buyer?.phone || '',
        },
      }),
    });

    res.json({
      id: response.id,
      initPoint: response.init_point,
      sandboxInitPoint: response.sandbox_init_point,
      externalReference,
    });
  } catch (error) {
    res.status(502).json({
      error: 'Nao foi possivel criar a preferencia no Mercado Pago.',
      detail: error?.message || String(error),
    });
  }
});

app.post('/api/webhooks/mercadopago', async (req, res) => {
  if (!accessToken) {
    res.status(500).json({ error: 'Mercado Pago nao configurado.' });
    return;
  }

  const paymentId = req.query['data.id'] || req.body?.data?.id || req.body?.id;

  if (webhookSecret && req.headers['x-signature']) {
    try {
      WebhookSignatureValidator.validate({
        xSignature: req.headers['x-signature'],
        xRequestId: req.headers['x-request-id'],
        dataId: req.query['data.id'],
        secret: webhookSecret,
        toleranceSeconds: 300,
      });
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) {
        res.status(401).json({ error: 'Assinatura do webhook invalida.' });
        return;
      }
      throw error;
    }
  }

  if (!paymentId) {
    res.json({ ok: true, message: 'Notificacao recebida sem id de pagamento.' });
    return;
  }

  try {
    const payment = new Payment(createMercadoPagoClient());
    const response = await payment.get({ id: paymentId });
    syncPaymentStatus(response);
    console.log('Webhook Mercado Pago:', {
      id: response.id,
      status: response.status,
      externalReference: response.external_reference,
    });
    res.json({
      ok: true,
      payment: {
        id: response.id,
        status: response.status,
        externalReference: response.external_reference,
      },
    });
  } catch (error) {
    res.status(502).json({
      error: 'Nao foi possivel consultar o pagamento do webhook.',
      detail: error?.message || String(error),
    });
  }
});

app.get(/.*/, (_req, res) => {
  res.json({
    ok: true,
    service: 'Rifa API',
    health: '/api/health',
  });
});

app.listen(port, () => {
  ensureDataFile();
  console.log(`Rifa rodando em http://127.0.0.1:${port}`);
});

function parsePhone(value = '') {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 10) return undefined;
  return {
    area_code: digits.slice(0, 2),
    number: digits.slice(2),
  };
}

function createMercadoPagoClient() {
  return new MercadoPagoConfig({
    accessToken,
    options: { timeout: 10000 },
  });
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== '')
  );
}

function cleanEnv(value = '') {
  return String(value).trim().replace(/^["']|["']$/g, '');
}

async function createPixPayment({ amount, buyer, numbers, idempotencyKey }) {
  const payload = compactObject({
    transaction_amount: amount,
    description: `${businessName} - Rifa Bicicleta nova zero`,
    payment_method_id: 'pix',
    external_reference: idempotencyKey,
    notification_url: process.env.MERCADO_PAGO_WEBHOOK_URL,
    metadata: {
      rifa: 'bicicleta-nova-zero',
      numbers: Array.isArray(numbers) ? numbers.join(',') : '',
      buyer_phone: buyer.phone || '',
    },
    payer: compactObject({
      email: buyer.email,
      first_name: buyer.name,
      phone: parsePhone(buyer.phone),
    }),
  });

  const response = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Mercado Pago respondeu ${response.status} sem JSON valido: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const message = data.message || data.error || JSON.stringify(data).slice(0, 300);
    throw new Error(`Mercado Pago respondeu ${response.status}: ${message}`);
  }

  return data;
}

function ensureDataFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(stateFile)) {
    saveState(defaultState());
    return;
  }

  const state = loadState();
  saveState(state);
}

function defaultState() {
  return {
    orders: [importedJoseOrder],
    winners: [],
  };
}

function loadState() {
  ensureDataDirectory();

  if (!fs.existsSync(stateFile)) {
    const initialState = defaultState();
    fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2));
    return initialState;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return normalizeState(parsed);
  } catch {
    const fallback = defaultState();
    fs.writeFileSync(stateFile, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

function saveState(state) {
  ensureDataDirectory();
  const normalized = normalizeState(state);
  fs.writeFileSync(stateFile, JSON.stringify(normalized, null, 2));
}

function ensureDataDirectory() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function normalizeState(value) {
  return {
    orders: Array.isArray(value.orders) ? value.orders.map(normalizeOrder).filter(Boolean) : [],
    winners: Array.isArray(value.winners) ? value.winners.map(normalizeWinner).filter(Boolean) : [],
  };
}

function normalizeOrder(order) {
  if (!order || !order.id || !Array.isArray(order.numbers) || !order.numbers.length) {
    return null;
  }

  return {
    id: String(order.id),
    name: String(order.name || 'Compra sem nome'),
    phone: String(order.phone || ''),
    email: String(order.email || ''),
    numbers: [...new Set(order.numbers.map((item) => String(item).padStart(4, '0')))].sort(),
    status: order.status === 'paid' ? 'paid' : 'reserved',
    createdAt: order.createdAt || new Date().toISOString(),
    updatedAt: order.updatedAt || undefined,
    mercadoPagoPaymentId: order.mercadoPagoPaymentId || undefined,
    mercadoPagoStatus: order.mercadoPagoStatus || undefined,
    ticketUrl: order.ticketUrl || undefined,
    imported: Boolean(order.imported),
  };
}

function normalizeWinner(winner) {
  if (!winner || !winner.number || !winner.prize) return null;
  return {
    prize: String(winner.prize),
    value: String(winner.value || ''),
    number: String(winner.number).padStart(4, '0'),
    name: String(winner.name || ''),
    phone: String(winner.phone || ''),
    drawnAt: winner.drawnAt || new Date().toISOString(),
  };
}

function mergeOrder(current, incoming) {
  return normalizeOrder({
    ...current,
    ...incoming,
    numbers: incoming.numbers?.length ? incoming.numbers : current.numbers,
  });
}

function syncPaymentStatus(payment) {
  const externalReference = payment.external_reference;
  if (!externalReference) return;

  const state = loadState();
  const order = state.orders.find((item) => item.id === externalReference);
  if (!order) return;

  order.mercadoPagoPaymentId = payment.id;
  order.mercadoPagoStatus = payment.status;
  order.updatedAt = new Date().toISOString();
  if (payment.status === 'approved') {
    order.status = 'paid';
  }

  saveState(state);
}
