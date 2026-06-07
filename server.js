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

  const client = new MercadoPagoConfig({
    accessToken,
    options: { timeout: 10000 },
  });
  const payment = new Payment(client);
  const idempotencyKey = orderId || crypto.randomUUID();

  try {
    const response = await payment.create({
      body: compactObject({
        transaction_amount: normalizedAmount,
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
      }),
      requestOptions: { idempotencyKey },
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
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
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
