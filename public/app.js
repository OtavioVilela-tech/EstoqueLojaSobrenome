'use strict';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const inteiroBR = new Intl.NumberFormat('pt-BR');

/* ---------- utilidades ---------- */

function el(tag, props = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const f of filhos.flat()) if (f != null) e.append(f);
  return e;
}

async function api(metodo, url, corpo) {
  const resp = await fetch(url, {
    method: metodo,
    headers: corpo ? { 'Content-Type': 'application/json' } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
    credentials: 'same-origin',
  });
  let dados = {};
  try { dados = await resp.json(); } catch { /* sem corpo */ }
  if (resp.status === 401 && url !== '/api/login') {
    mostrarAuth(true);
    throw new Error('Sua sessão expirou. Entre novamente.');
  }
  if (!resp.ok) throw new Error(dados.erro || 'Não foi possível concluir a ação.');
  return dados;
}

let temporizadorAviso;
function avisar(msg) {
  const a = $('#aviso');
  a.textContent = msg;
  a.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => (a.hidden = true), 3000);
}

function mostrarErro(elemento, msg) {
  elemento.textContent = msg;
  elemento.hidden = !msg;
}

function dataBR(sqlUtc) {
  const d = new Date(sqlUtc.replace(' ', 'T') + 'Z');
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function situacao(p) {
  if (p.quantidade === 0) return { chave: 'zero', texto: 'Sem estoque' };
  if (p.quantidade <= p.estoque_minimo) return { chave: 'baixo', texto: 'Estoque baixo' };
  return { chave: 'ok', texto: 'Em estoque' };
}

/* ---------- entrada (primeiro acesso e login) ---------- */

let configurado = true;

function mostrarAuth(sessaoExpirada = false) {
  $('#app').hidden = true;
  $('#auth').hidden = false;
  const novo = !configurado;
  $('#auth-titulo').textContent = novo ? 'Criar acesso do dono' : 'Entrar';
  $('#auth-texto').textContent = novo
    ? 'Escolha um usuário e uma senha. Só quem tiver esses dados vai ver o estoque.'
    : 'Use o usuário e a senha do dono da loja.';
  $('#auth-enviar').textContent = novo ? 'Criar acesso' : 'Entrar';
  $('#auth-senha').autocomplete = novo ? 'new-password' : 'current-password';
  mostrarErro($('#auth-erro'), sessaoExpirada ? 'Sua sessão expirou. Entre novamente.' : '');
  $('#auth-usuario').focus();
}

$('#form-auth').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const dados = { usuario: $('#auth-usuario').value, senha: $('#auth-senha').value };
  try {
    const r = await api('POST', configurado ? '/api/login' : '/api/setup', dados);
    configurado = true;
    $('#form-auth').reset();
    entrarNoSistema(r.usuario);
  } catch (e) {
    mostrarErro($('#auth-erro'), e.message);
  }
});

$('#btn-sair').addEventListener('click', async () => {
  try { await api('POST', '/api/logout'); } catch { /* já saiu */ }
  mostrarAuth();
});

function entrarNoSistema(usuario) {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#nome-usuario').textContent = usuario;
  recarregarTudo();
}

/* ---------- abas ---------- */

document.querySelectorAll('.aba').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.aba').forEach((x) => x.classList.toggle('ativa', x === b));
    $('#aba-estoque').hidden = b.dataset.aba !== 'estoque';
    $('#aba-movimentacoes').hidden = b.dataset.aba !== 'movimentacoes';
    if (b.dataset.aba === 'movimentacoes') carregarMovimentacoes();
  })
);

/* ---------- estoque ---------- */

let produtos = [];

async function recarregarTudo() {
  try {
    await Promise.all([carregarResumo(), carregarCategorias(), carregarProdutos()]);
    if (!$('#aba-movimentacoes').hidden) carregarMovimentacoes();
  } catch (e) {
    avisar(e.message);
  }
}

async function carregarResumo() {
  const r = await api('GET', '/api/resumo');
  const precisaRepor = r.estoque_baixo + r.zerados;
  const dl = $('#resumo');
  dl.replaceChildren(
    item('Peças em estoque', inteiroBR.format(r.pecas), `${inteiroBR.format(r.modelos)} cadastrada(s)`),
    item('Valor a preço de custo', brl.format(r.valor_custo)),
    item('Valor a preço de venda', brl.format(r.valor_venda)),
    el(
      'div',
      { class: 'alerta' + (precisaRepor === 0 ? ' zero-alertas' : '') },
      el('dt', {}, 'Precisam de reposição'),
      el(
        'dd',
        {},
        inteiroBR.format(precisaRepor),
        precisaRepor > 0
          ? el('button', { class: 'link', type: 'button', onclick: () => {
              $('#filtro-situacao').value = 'alerta';
              carregarProdutos();
            } }, 'Ver quais')
          : el('span', { class: 'sub' }, 'Tudo em dia')
      )
    )
  );
}

function item(rotulo, valor, sub) {
  return el('div', {}, el('dt', {}, rotulo), el('dd', {}, valor, sub ? el('span', { class: 'sub' }, sub) : null));
}

async function carregarCategorias() {
  const cats = await api('GET', '/api/categorias');
  const sel = $('#filtro-categoria');
  const atual = sel.value;
  sel.replaceChildren(el('option', { value: '' }, 'Todas as categorias'), ...cats.map((c) => el('option', { value: c }, c)));
  sel.value = cats.includes(atual) ? atual : '';
  $('#lista-categorias').replaceChildren(...cats.map((c) => el('option', { value: c })));
}

async function carregarProdutos() {
  const q = new URLSearchParams();
  if ($('#busca').value.trim()) q.set('busca', $('#busca').value.trim());
  if ($('#filtro-categoria').value) q.set('categoria', $('#filtro-categoria').value);
  if ($('#filtro-situacao').value) q.set('situacao', $('#filtro-situacao').value);
  produtos = await api('GET', '/api/produtos?' + q);
  desenharProdutos();
}

function desenharProdutos() {
  const filtrando = $('#busca').value.trim() || $('#filtro-categoria').value || $('#filtro-situacao').value;
  $('#corpo-estoque').replaceChildren(...produtos.map(linhaProduto));
  const vazio = $('#vazio');
  $('#tabela-estoque').hidden = produtos.length === 0;
  vazio.hidden = produtos.length !== 0;
  vazio.textContent = filtrando
    ? 'Nenhuma peça encontrada com esses filtros.'
    : 'Seu estoque está vazio. Use "Nova peça" para cadastrar a primeira.';
}

function linhaProduto(p) {
  const s = situacao(p);
  const base = Math.max(p.estoque_minimo * 3, 1);
  const pct = p.quantidade === 0 ? 0 : Math.max(6, Math.min(100, (p.quantidade / base) * 100));
  return el(
    'tr',
    {},
    el('td', { class: 'cel-peca' }, el('div', { class: 'peca-nome' }, p.nome), p.cor ? el('div', { class: 'peca-cor' }, p.cor) : null),
    el('td', { dataset: { rotulo: 'Categoria' } }, p.categoria),
    el('td', { dataset: { rotulo: 'Tamanho' } }, el('span', { class: 'tam' }, p.tamanho)),
    el(
      'td',
      { class: 'cel-nivel' },
      el(
        'div',
        { class: 'nivel' },
        el('div', { class: 'nivel-topo' }, el('span', { class: 'qtd' }, String(p.quantidade)), el('span', { class: 'selo ' + s.chave }, s.texto)),
        el('div', { class: 'medidor', 'aria-hidden': 'true' }, el('i', { class: s.chave, style: `width:${pct}%` }))
      )
    ),
    el('td', { class: 'dir num', dataset: { rotulo: 'Custo' } }, brl.format(p.preco_custo)),
    el('td', { class: 'dir num', dataset: { rotulo: 'Venda' } }, brl.format(p.preco_venda)),
    el(
      'td',
      {},
      el(
        'div',
        { class: 'acoes' },
        el('button', { class: 'btn pequeno primario', type: 'button', onclick: () => abrirMovimento(p) }, 'Movimentar'),
        el('button', { class: 'btn pequeno', type: 'button', onclick: () => abrirProduto(p) }, 'Editar'),
        el('button', { class: 'btn pequeno', type: 'button', onclick: () => excluirProduto(p) }, 'Excluir')
      )
    )
  );
}

let temporizadorBusca;
$('#busca').addEventListener('input', () => {
  clearTimeout(temporizadorBusca);
  temporizadorBusca = setTimeout(() => carregarProdutos().catch((e) => avisar(e.message)), 250);
});
$('#filtro-categoria').addEventListener('change', () => carregarProdutos().catch((e) => avisar(e.message)));
$('#filtro-situacao').addEventListener('change', () => carregarProdutos().catch((e) => avisar(e.message)));

/* ---------- diálogos ---------- */

document.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// Cadastro / edição
let editandoId = null;
const formProduto = $('#form-produto');

function atualizarMargem() {
  const custo = Number(formProduto.preco_custo.value) || 0;
  const venda = Number(formProduto.preco_venda.value) || 0;
  $('#margem').textContent =
    venda > 0
      ? `Lucro por peça: ${brl.format(venda - custo)} (${Math.round(((venda - custo) / venda) * 100)}% do preço de venda)`
      : '';
}
formProduto.preco_custo.addEventListener('input', atualizarMargem);
formProduto.preco_venda.addEventListener('input', atualizarMargem);

function abrirProduto(p) {
  editandoId = p ? p.id : null;
  formProduto.reset();
  mostrarErro($('#erro-produto'), '');
  $('#dlg-produto-titulo').textContent = p ? 'Editar peça' : 'Nova peça';
  $('#campo-qtd-inicial').hidden = !!p; // quantidade só muda por movimentação
  if (p) {
    for (const k of ['nome', 'categoria', 'cor', 'tamanho', 'estoque_minimo', 'preco_custo', 'preco_venda']) formProduto[k].value = p[k];
  }
  atualizarMargem();
  $('#dlg-produto').showModal();
  formProduto.nome.focus();
}
$('#btn-nova').addEventListener('click', () => abrirProduto(null));

formProduto.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(formProduto);
  const corpo = Object.fromEntries(f.entries());
  try {
    if (editandoId) await api('PUT', `/api/produtos/${editandoId}`, corpo);
    else await api('POST', '/api/produtos', corpo);
    $('#dlg-produto').close();
    avisar('Peça salva.');
    recarregarTudo();
  } catch (e) {
    mostrarErro($('#erro-produto'), e.message);
  }
});

// Movimentação
let movProduto = null;
const formMov = $('#form-mov');
const ROTULOS_MOV = {
  entrada: ['Quantidade que chegou', 1],
  saida: ['Quantidade que saiu', 1],
  ajuste: ['Quantidade contada na prateleira', 0],
};

function atualizarRotuloMov() {
  const tipo = formMov.tipo.value;
  const [texto, min] = ROTULOS_MOV[tipo];
  $('#mov-rotulo-qtd').firstChild.textContent = texto;
  formMov.quantidade.min = String(min);
  if (tipo === 'ajuste') formMov.quantidade.value = movProduto ? movProduto.quantidade : 0;
  else if (Number(formMov.quantidade.value) < 1) formMov.quantidade.value = 1;
}
formMov.querySelectorAll('input[name="tipo"]').forEach((r) => r.addEventListener('change', atualizarRotuloMov));

function abrirMovimento(p) {
  movProduto = p;
  formMov.reset();
  mostrarErro($('#erro-mov'), '');
  $('#mov-peca').textContent = `${p.nome}${p.cor ? ' · ' + p.cor : ''} · tamanho ${p.tamanho} · hoje: ${p.quantidade} un.`;
  atualizarRotuloMov();
  $('#dlg-mov').showModal();
  formMov.quantidade.select();
}

formMov.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('POST', `/api/produtos/${movProduto.id}/movimentar`, {
      tipo: formMov.tipo.value,
      quantidade: formMov.quantidade.value,
      observacao: formMov.observacao.value,
    });
    $('#dlg-mov').close();
    avisar('Movimentação registrada.');
    recarregarTudo();
  } catch (e) {
    mostrarErro($('#erro-mov'), e.message);
  }
});

// Exclusão
async function excluirProduto(p) {
  const dlg = $('#dlg-excluir');
  $('#excluir-texto').textContent = `"${p.nome}" (${p.tamanho}) e todo o histórico dessa peça serão apagados. Essa ação não pode ser desfeita.`;
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener(
    'close',
    async () => {
      if (dlg.returnValue !== 'excluir') return;
      try {
        await api('DELETE', `/api/produtos/${p.id}`);
        avisar('Peça excluída.');
        recarregarTudo();
      } catch (e) {
        avisar(e.message);
      }
    },
    { once: true }
  );
}

/* ---------- movimentações ---------- */

const NOMES_TIPO = { entrada: 'Entrada', saida: 'Saída', ajuste: 'Contagem' };

async function carregarMovimentacoes() {
  try {
    const lista = await api('GET', '/api/movimentacoes?limite=100');
    $('#vazio-mov').hidden = lista.length !== 0;
    $('#tabela-mov').hidden = lista.length === 0;
    $('#corpo-mov').replaceChildren(
      ...lista.map((m) =>
        el(
          'tr',
          {},
          el('td', { dataset: { rotulo: 'Data' } }, dataBR(m.criado_em)),
          el('td', { class: 'cel-peca' }, el('div', { class: 'peca-nome' }, m.nome), el('div', { class: 'peca-cor' }, [m.cor, 'tam. ' + m.tamanho].filter(Boolean).join(' · '))),
          el('td', { dataset: { rotulo: 'Tipo' } }, el('span', { class: 'tipo-mov ' + m.tipo }, NOMES_TIPO[m.tipo])),
          el('td', { class: 'dir num', dataset: { rotulo: 'Quantidade' } }, (m.quantidade > 0 ? '+' : '') + m.quantidade),
          el('td', { class: 'dir num', dataset: { rotulo: 'Saldo' } }, String(m.saldo_apos)),
          el('td', { dataset: { rotulo: 'Observação' } }, m.observacao || '—')
        )
      )
    );
  } catch (e) {
    avisar(e.message);
  }
}

/* ---------- início ---------- */

(async function iniciar() {
  try {
    const s = await api('GET', '/api/status');
    configurado = s.configurado;
    if (s.autenticado) entrarNoSistema(s.usuario);
    else mostrarAuth();
  } catch (e) {
    mostrarAuth();
    mostrarErro($('#auth-erro'), 'Não foi possível falar com o servidor.');
  }
})();
