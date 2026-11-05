const grid = document.querySelector('#product-grid');
const searchInput = document.querySelector('#product-search');
const filters = document.querySelector('#category-filters');
const resultCount = document.querySelector('#result-count');
const emptyState = document.querySelector('#empty-state');
const snapshotDate = document.querySelector('#snapshot-date');

let products = [];
let activeCategory = '';

const money = (cents) => new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
}).format(cents / 100);

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function makeCategoryButton(label, value) {
  const button = node('button', 'category-button', label);
  button.type = 'button';
  button.dataset.category = value;
  button.setAttribute('aria-pressed', String(activeCategory === value));
  button.addEventListener('click', () => {
    activeCategory = value;
    for (const item of filters.querySelectorAll('button')) {
      item.setAttribute('aria-pressed', String(item.dataset.category === activeCategory));
    }
    render();
  });
  return button;
}

function makeProductCard(product) {
  const card = node('article', 'product-card');
  const media = node('div', 'product-media');
  if (product.image) {
    const img = document.createElement('img');
    img.src = product.image;
    img.alt = `Foto ilustrativa de ${product.name}`;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = () => { img.hidden = true; };
    media.append(img);
    media.append(node('span', 'photo-badge', 'Foto ilustrativa'));
  }

  const copy = node('div', 'product-copy');
  copy.append(node('span', 'product-category', product.category));
  copy.append(node('h3', 'product-name', product.name));
  if (product.description) copy.append(node('p', 'product-description', product.description));
  const price = `${product.fromPrice ? 'A partir de ' : ''}${money(product.priceCents)}`;
  copy.append(node('p', 'product-price', price));
  card.append(media, copy);
  return card;
}

function render() {
  const query = searchInput.value.trim().toLocaleLowerCase('pt-BR');
  const visible = products.filter((product) => {
    const categoryMatches = !activeCategory || product.category === activeCategory;
    const text = `${product.name} ${product.category} ${product.description}`.toLocaleLowerCase('pt-BR');
    return categoryMatches && (!query || text.includes(query));
  });

  grid.replaceChildren(...visible.map(makeProductCard));
  resultCount.textContent = `${visible.length} ${visible.length === 1 ? 'produto' : 'produtos'}`;
  emptyState.hidden = visible.length !== 0;
}

async function start() {
  try {
    const response = await fetch('/catalog.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('Catálogo indisponível');
    const data = await response.json();
    products = Array.isArray(data.products) ? data.products : [];
    const date = new Date(`${data.snapshotDate}T12:00:00Z`);
    snapshotDate.textContent = `Catálogo atualizado em ${date.toLocaleDateString('pt-BR', { timeZone: 'UTC' })}`;

    const categories = [...new Set(products.map((product) => product.category).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    filters.append(makeCategoryButton('Todas', ''));
    for (const category of categories) filters.append(makeCategoryButton(category, category));
    searchInput.addEventListener('input', render);
    render();
  } catch {
    resultCount.textContent = 'Não foi possível carregar o catálogo.';
    emptyState.hidden = false;
    emptyState.textContent = 'Tente atualizar a página. Se o problema continuar, fale com a loja pelo WhatsApp.';
  }
}

void start();
