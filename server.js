const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

const pastaRelatorios = path.join(__dirname, 'relatorios');
const arqProdutos = path.join(__dirname, 'produtos.json');

if (!fs.existsSync(pastaRelatorios)) fs.mkdirSync(pastaRelatorios);

// Produtos Iniciais Padrão
const produtosPadrao = [
  { id: "202", nome: "Salgado Frito", categoria: "comidas", precoOnibus: 8.00, precoPasseio: 9.00 },
  { id: "201", nome: "Salgado Assado", categoria: "comidas", precoOnibus: 8.00, precoPasseio: 9.00 },
  { id: "117", nome: "Refri Lata", categoria: "bebidas", precoOnibus: 10.00, precoPasseio: 10.00 },
  { id: "134", nome: "Cerveja Lata", categoria: "cervejas", precoOnibus: 9.00, precoPasseio: 10.00 }
];

let produtos = [];
function carregarProdutos() {
  if (fs.existsSync(arqProdutos)) {
    try {
      produtos = JSON.parse(fs.readFileSync(arqProdutos, 'utf-8'));
    } catch (e) {
      produtos = produtosPadrao;
    }
  } else {
    produtos = produtosPadrao;
    salvarProdutos();
  }
}

function salvarProdutos() {
  fs.writeFileSync(arqProdutos, JSON.stringify(produtos, null, 2));
}
carregarProdutos();

const PIN_BALCAO = "1234"; // Código PIN de Acesso ao Balcão
let comandasAtivas = {};
let turnoAtual = { nome: "Turno 1 - Manhã", inicio: new Date(), historicoVendas: [] };

function recalcularTotal(numComanda) {
  if (comandasAtivas[numComanda]) {
    comandasAtivas[numComanda].total = comandasAtivas[numComanda].itens.reduce(
      (acc, i) => acc + (i.preco * i.qtd), 0
    );
  }
}

// Rota para abrir a comanda via QR Code
app.get('/comanda', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'comanda.html'));
});

io.on('connection', (socket) => {
  socket.emit('atualizar-caixa', { comandas: comandasAtivas, turno: turnoAtual });
  socket.emit('atualizar-produtos', produtos);

  // Autenticação Balconista
  socket.on('login-balcao', (pin) => {
    if (pin !== PIN_BALCAO) {
      socket.emit('login-resposta', { sucesso: false, msg: 'Código incorreto!' });
      return;
    }
    socket.emit('login-resposta', { sucesso: true, msg: 'Autorizado!' });
  });

  // Gestão de Produtos
  socket.on('salvar-produto', (pData) => {
    const idx = produtos.findIndex(p => p.id === pData.id);
    const prodFormatado = {
      id: String(pData.id).trim(),
      nome: pData.nome,
      categoria: pData.categoria,
      precoOnibus: parseFloat(pData.precoOnibus) || 0,
      precoPasseio: parseFloat(pData.precoPasseio) || 0
    };

    if (idx >= 0) produtos[idx] = prodFormatado;
    else produtos.push(prodFormatado);

    salvarProdutos();
    io.emit('atualizar-produtos', produtos);
  });

  socket.on('deletar-produto', (id) => {
    produtos = produtos.filter(p => p.id !== String(id));
    salvarProdutos();
    io.emit('atualizar-produtos', produtos);
  });

  // Lançamentos
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
    io.emit('atualizar-caixa', { comandas: comandasAtivas, turno: turnoAtual });
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
    io.emit('atualizar-caixa', { comandas: comandasAtivas, turno: turnoAtual });
  });

  socket.on('remover-item', (data) => {
    const { numComanda, indexItem } = data;
    if (comandasAtivas[numComanda] && comandasAtivas[numComanda].itens[indexItem]) {
      const item = comandasAtivas[numComanda].itens[indexItem];
      if (item.qtd > 1) item.qtd -= 1;
      else comandasAtivas[numComanda].itens.splice(indexItem, 1);

      recalcularTotal(numComanda);
      io.emit('atualizar-caixa', { comandas: comandasAtivas, turno: turnoAtual });
    }
  });

  // Fechamento da Comanda
  socket.on('fechar-comanda', (numComanda) => {
    if (comandasAtivas[numComanda]) {
      turnoAtual.historicoVendas.push({
        numComanda,
        ...comandasAtivas[numComanda],
        horaPagamento: new Date().toLocaleTimeString('pt-BR')
      });
      delete comandasAtivas[numComanda];
      io.emit('atualizar-caixa', { comandas: comandasAtivas, turno: turnoAtual });
    }
  });

  // Relatório e Fechamento de Caixa
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
    io.emit('atualizar-caixa', { comandas: comandasAtivas, turno: turnoAtual });
    socket.emit('turno-fechado-sucesso', nomeArquivo);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));