require('dotenv').config();

const crypto = require('crypto');
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
const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const webhookSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
const businessName = process.env.BUSINESS_NAME || 'RIFAS E BONUS LTDA';

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mercadoPagoConfigured: Boolean(accessToken),
    webhookSecretConfigured: Boolean(webhookSecret),
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || '',
  });
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
