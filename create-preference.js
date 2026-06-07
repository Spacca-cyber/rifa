require('dotenv').config();

const crypto = require('crypto');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const businessName = process.env.BUSINESS_NAME || 'RIFAS E BONUS LTDA';

if (!accessToken) {
  console.error('Configure MERCADO_PAGO_ACCESS_TOKEN no arquivo .env antes de criar a preferencia.');
  process.exit(1);
}

async function main() {
  const client = new MercadoPagoConfig({
    accessToken,
    options: { timeout: 10000 },
  });
  const preference = new Preference(client);

  const response = await preference.create({
    body: {
      items: [
        {
          id: 'rifa-bicicleta',
          title: `${businessName} - Rifa Bicicleta nova zero`,
          quantity: 1,
          unit_price: 0.25,
          currency_id: 'BRL',
        },
      ],
      external_reference: crypto.randomUUID(),
      metadata: {
        rifa: 'bicicleta-nova-zero',
      },
    },
  });

  console.log('Preference ID:', response.id);
  console.log('Checkout:', response.init_point);
  console.log('Sandbox:', response.sandbox_init_point);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
