const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Altere para a URL oficial onde seu site vai rodar na Nuvem
const URL_BASE_DOMINIO = "https://boidaestrada.onrender.com"; 
const QTD_COMANDAS = 100;

const pastaDestino = path.join(__dirname, 'qrcodes_para_grafica');
if (!fs.existsSync(pastaDestino)) fs.mkdirSync(pastaDestino);

console.log('Gerando QR Codes definitivos...');

for (let i = 1; i <= QTD_COMANDAS; i++) {
  const numComanda = String(i).padStart(2, '0');
  const url = `${URL_BASE_DOMINIO}/comanda?id=${numComanda}`;
  const caminhoImagem = path.join(pastaDestino, `comanda_${numComanda}.png`);

  QRCode.toFile(caminhoImagem, url, {
    width: 400,
    margin: 2
  }, (err) => {
    if (err) console.error(`Erro ao gerar comanda ${numComanda}:`, err);
  });
}

console.log(`Sucesso! ${QTD_COMANDAS} QR Codes gerados na pasta /qrcodes_para_grafica.`);