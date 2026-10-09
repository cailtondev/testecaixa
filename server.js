const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const pastaRelatorios = path.join(__dirname, 'relatorios');
if (!fs.existsSync(pastaRelatorios)) fs.mkdirSync(pastaRelatorios);

// CONEXÃO COM O MONGODB ATLAS
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://cailtondev_db_user:<db_password>@dadoscaixa.nnb7cjq.mongodb.net/?appName=dadoscaixa"
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Conectado ao MongoDB Atlas com sucesso!'))
  .catch(err => console.error('❌ Erro de Conexão no MongoDB:', err));

// SCHEMA DE PRODUTOS
const produtoSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  nome: String,
  categoria: String,
  precoOnibus: Number,
  precoPasseio: Number
});
const Produto = mongoose.model('Produto', produtoSchema);

const PIN_BALCAO = "1234";
let comandasAtivas = {};
let modoOnibusAtivo = false;
let turnoAtual = { nome: "Turno 1 - Manhã", inicio: new Date(), historicoVendas: [] };

function recalcularTotal(numComanda) {
  if (comandasAtivas[numComanda]) {
    comandasAtivas[numComanda].total = comandasAtivas[numComanda].itens.reduce(
      (acc, i) => acc + (i.preco * i.qtd), 0
    );
  }
}

app.get('/comanda', (req, res) => res.sendFile(path.join(__dirname, 'public', 'comanda.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'caixa.html')));

io.on('connection', async (socket) => {
  // Busca produtos no MongoDB ao conectar
  const listaProds = await Produto.find().sort({ id: 1 });
  
  socket.emit('atualizar-caixa', { comandas: comandasAtivas, turno: turnoAtual, modoOnibus: modoOnibusAtivo });
  socket.emit('atualizar-produtos', listaProds);

  socket.on('login-balcao', (pin) => {
    if (pin !== PIN_BALCAO) {
      socket.emit('login-resposta', { sucesso: false, msg: 'Código incorreto!' });
      return;
    }
    socket.emit('login-resposta', { sucesso: true, msg: 'Autorizado!' });
  });

  // ACIONAMENTO DE ALERTA DE ÔNIBUS (Caixa / Escritório)
  socket.on('alternar-alerta-onibus', (status) => {
    modoOnibusAtivo = status;
    io.emit('alerta-onibus-disparado', modoOnibusAtivo);
    io.emit('atualizar-caixa', { comandas: comandasAtivas, turno: turnoAtual, modoOnibus: modoOnibusAtivo });
  });

  // GESTÃO DE PRODUTOS (ESCRITÓRIO)
  socket.on('salvar-produto', async (pData) => {
    try {
      const prodFormatado = {
        id: String(pData.id).trim(),
        nome: pData.nome,
        categoria: pData.categoria,
        precoOnibus: parseFloat(pData.precoOnibus) || 0,
        precoPasseio: parseFloat(pData.precoPasseio) || 0
      };

      await Produto.findOneAndUpdate({ id: prodFormatado.id }, prodFormatado, { upsert: true, new: true });
      const listaProdsAtualizada = await Produto.find().sort({ id: 1 });
      io.emit('atualizar-produtos', listaProdsAtualizada);
    } catch (e) {
      console.error('Erro ao salvar produto:', e);
    }
  });

  socket.on('deletar-produto', async (id) => {
    await Produto.deleteOne({ id: String(id) });
    const listaProdsAtualizada = await Produto.find().sort({ id: 1 });
    io.emit('atualizar-produtos', listaProdsAtualizada);
  });

  // LANÇAMENTOS
  socket.on('lancar-item', (data) => {
    const { numComanda, itemObj, tabela, qtd = 1 } = data;
    if (!numComanda) return;

    if (!comandasAtivas[numComanda]) {
      comandasAtivas[numComanda] = { tabela: tabela || 'onibus', itens: [], total: 0 };
    }
    if (tabela) comandasAtivas[numComanda].tabela = tabela;

    const tabAtual = comandasAtivas[numComanda].tabela;
    const precoAplicado = (tabAtual === 'passeio') ? itemObj.precoPasseio : itemObj.precoOnibus;
    const nomeCompleto = `${itemObj.id} - ${itemObj.nome}`;

    const itemExistente = comandasAtivas[numComanda].itens.find(
      i => i.nome === nomeCompleto && i.preco === precoAplicado
    );

    if (itemExistente) {
      itemExistente.qtd += parseInt(qtd) || 1;
    } else {
      comandasAtivas[numComanda].itens.push({
        nome: nomeCompleto,
        preco: precoAplicado,
        qtd: parseInt(qtd) || 1
      });
    }

    recalcularTotal(numComanda);
    io.emit('atualizar-caixa', { comandas: comandasAtivas, turno: turnoAtual, modoOnibus: modoOnibusAtivo });
  });

  socket.on('lancar-manual', (data) => {
    const { numComanda, nome, valor, tabela } = data;
    const valPreco = parseFloat(valor);
    if (!numComanda || isNaN(valPreco) || valPreco <= 0) return;

    if (!comandasAtivas[numComanda]) {
      comandasAtivas[numComanda] = { tabela: tabela || 'onibus', itens: [], total: 0 };
    }

    comandasAtivas[numComanda].itens.push({ nome, preco: valPreco, qtd: 1 });
    recalcularTotal(numComanda);
    io.emit('atualizar-caixa', { comandas: comandasAtivas, turno: turnoAtual, modoOnibus: modoOnibusAtivo });
  });

  socket.on('remover-item', (data) => {
    const { numComanda, indexItem } = data;
    if (comandasAtivas[numComanda] && comandasAtivas[numComanda].itens[indexItem]) {
      const item = comandasAtivas[numComanda].itens[indexItem];
      if (item.qtd > 1) item.qtd -= 1;
      else comandasAtivas[numComanda].itens.splice(indexItem, 1);

      recalcularTotal(numComanda);
      io.emit('atualizar-caixa', { comandas: comandasAtivas, turno: turnoAtual, modoOnibus: modoOnibusAtivo });
    }
  });

  socket.on('fechar-comanda', (numComanda) => {
    if (comandasAtivas[numComanda]) {
      turnoAtual.historicoVendas.push({
        numComanda,
        ...comandasAtivas[numComanda],
        horaPagamento: new Date().toLocaleTimeString('pt-BR')
      });
      delete comandasAtivas[numComanda];
      io.emit('atualizar-caixa', { comandas: comandasAtivas, turno: turnoAtual, modoOnibus: modoOnibusAtivo });
    }
  });

  socket.on('fechar-turno', (novoNomeTurno) => {
    const agora = new Date();
    const dataStr = agora.toISOString().split('T')[0];
    const horaStr = agora.toTimeString().split(' ')[0].replace(/:/g, '-');
    const nomeArquivo = `Relatorio_${dataStr}_${horaStr}.pdf`;
    const caminhoPDF = path.join(pastaRelatorios, nomeArquivo);

    const doc = new PDFDocument({ margin: 30 });
    doc.pipe(fs.createWriteStream(caminhoPDF));

    doc.fontSize(18).text('BOI DA ESTRADA - FECHAMENTO DE CAIXA', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Turno: ${turnoAtual.nome}`);
    doc.text(`Abertura: ${turnoAtual.inicio.toLocaleString('pt-BR')}`);
    doc.text(`Fechamento: ${agora.toLocaleString('pt-BR')}`);
    doc.moveDown();

    let totalGeral = 0;
    doc.fontSize(14).text('Comandas Processadas:', { underline: true });
    doc.moveDown(0.5);

    turnoAtual.historicoVendas.forEach((c) => {
      totalGeral += c.total;
      doc.fontSize(11).text(`Comanda #${c.numComanda} [${c.tabela.toUpperCase()}] - Hora: ${c.horaPagamento} - Total: R$ ${c.total.toFixed(2)}`);
      c.itens.forEach(i => {
        const txtQtd = i.qtd > 1 ? `${i.qtd}x ` : '';
        doc.fontSize(9).text(`   - ${txtQtd}${i.nome}: R$ ${(i.preco * i.qtd).toFixed(2)}`);
      });
      doc.moveDown(0.3);
    });

    doc.moveDown();
    doc.fontSize(16).text(`TOTAL FATURADO NO TURNO: R$ ${totalGeral.toFixed(2)}`, { align: 'right' });
    doc.end();

    turnoAtual = { nome: novoNomeTurno || "Novo Turno", inicio: new Date(), historicoVendas: [] };
    io.emit('atualizar-caixa', { comandas: comandasAtivas, turno: turnoAtual, modoOnibus: modoOnibusAtivo });
    socket.emit('turno-fechado-sucesso', nomeArquivo);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
