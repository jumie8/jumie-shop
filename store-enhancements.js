/* JUMIE storefront enhancements — preserves existing Supabase and Flutterwave checkout */
(function(){
  'use strict';
  const $ = id => document.getElementById(id);
  const money = n => '₦' + Number(n || 0).toLocaleString('en-NG');
  const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const style = document.createElement('style');
  style.textContent = `
    .jumie-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}
    .jumie-tools select,.jumie-tools button{border:1px solid #e1e2e6;background:#fff;border-radius:7px;padding:9px 11px;font-size:12px}
    .jumie-tools button.active{border-color:#f68b1f;background:#fff3e7;color:#b94d00;font-weight:800}
    .product{position:relative}.product .jumie-wish{position:absolute;right:9px;top:9px;width:32px;height:32px;border:0;border-radius:50%;background:#fff;box-shadow:0 1px 6px #0002;color:#777;font-size:19px;padding:0}
    .product .jumie-wish.saved{color:#e33e64}.product .jumie-view{width:100%;margin-top:6px;border:1px solid #ddd;background:#fff;color:#444;border-radius:7px;padding:8px;font-size:11px;font-weight:700}
    .jumie-cart-line{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:12px 0;border-bottom:1px solid #e8e9ed}
    .jumie-qty{display:flex;align-items:center;gap:7px}.jumie-qty button{width:27px;height:27px;border:1px solid #ddd;background:#fff;border-radius:5px}
    .jumie-remove{border:0;background:#fff0f0;color:#b42318;border-radius:5px;padding:7px;font-size:11px}
    .jumie-modal{position:fixed;inset:0;z-index:9999;background:#0008;display:none;align-items:center;justify-content:center;padding:16px}
    .jumie-modal.open{display:flex}.jumie-modal-card{position:relative;background:#fff;border-radius:12px;padding:20px;max-width:520px;width:100%;max-height:90vh;overflow:auto}
    .jumie-modal-card img{width:100%;height:230px;object-fit:contain}.jumie-modal-close{position:absolute;right:10px;top:10px;border:0;background:#eee;border-radius:50%;width:32px;height:32px;font-size:20px}
    .jumie-empty{background:#fff;padding:22px;border-radius:9px;text-align:center;color:#777;grid-column:1/-1}
    @media(max-width:520px){.jumie-cart-line{grid-template-columns:minmax(0,1fr) auto}.jumie-cart-line .jumie-remove{grid-column:2}}
  `;
  document.head.appendChild(style);

  const saved = new Set(JSON.parse(localStorage.getItem('jumieWishlist') || '[]').map(String));
  let recent = JSON.parse(localStorage.getItem('jumieRecentlyViewed') || '[]').map(String);
  let sortMode = 'featured', wishlistOnly = false;
  const catalog = $('products');
  if (!catalog) return;

  // Add the Jumia-inspired product discovery controls without changing product records.
  const tools = document.createElement('div');
  tools.className = 'jumie-tools';
  tools.id = 'wishlist';
  tools.innerHTML = '<button type="button" class="active" data-jumie-filter="all">All products</button><button type="button" data-jumie-filter="Phones & Tablets">Phones</button><button type="button" data-jumie-filter="Fashion">Fashion</button><button type="button" data-jumie-filter="Electronics">Electronics</button><button type="button" data-jumie-filter="Home">Home</button><button type="button" data-jumie-filter="Beauty">Beauty</button><button type="button" id="jumieWishlistToggle">♡ My Wishlist</button><select id="jumieSort" aria-label="Sort products"><option value="featured">Recommended</option><option value="low">Price: Low to High</option><option value="high">Price: High to Low</option><option value="name">Name: A to Z</option></select>';
  catalog.parentNode.insertBefore(tools, catalog);

  const modal = document.createElement('div');
  modal.className = 'jumie-modal';
  modal.id = 'jumieProductModal';
  modal.innerHTML = '<div class="jumie-modal-card"><button class="jumie-modal-close" type="button" aria-label="Close">×</button><div id="jumieProductDetails"></div></div>';
  document.body.appendChild(modal);

  function category(p){
    const text = ((p.name||'')+' '+(p.description||'')+' '+(p.category||'')).toLowerCase();
    if(/phone|iphone|samsung|tecno|infinix|tablet|redmi/.test(text))return 'Phones & Tablets';
    if(/dress|shirt|jean|shoe|sneaker|bag|fashion|clothing|wear/.test(text))return 'Fashion';
    if(/beauty|cream|makeup|perfume|skin|hair/.test(text))return 'Beauty';
    if(/laptop|computer|speaker|earbud|headphone|tv|camera|electronic/.test(text))return 'Electronics';
    if(/kitchen|home|chair|bed|cook|furniture|appliance/.test(text))return 'Home';
    return 'Other';
  }
  function productsList(){
    let list = (products || []).filter(p=>{
      const q = $('search')?.value.toLowerCase().trim() || '';
      const matchText = ((p.name||'')+' '+(p.description||'')+' '+(p.category||'')).toLowerCase().includes(q);
      const matchCat = window.jumieCategory === 'all' || category(p) === window.jumieCategory;
      const matchWish = !wishlistOnly || saved.has(String(p.id));
      return matchText && matchCat && matchWish;
    });
    if(sortMode==='low') list.sort((a,b)=>Number(a.price)-Number(b.price));
    if(sortMode==='high') list.sort((a,b)=>Number(b.price)-Number(a.price));
    if(sortMode==='name') list.sort((a,b)=>String(a.name).localeCompare(String(b.name)));
    return list;
  }
  function persist(){
    localStorage.setItem('jumieWishlist',JSON.stringify([...saved]));
    localStorage.setItem('jumieRecentlyViewed',JSON.stringify(recent));
    localStorage.setItem('jumieCart',JSON.stringify(cart));
  }
  function decorate(){
    if(typeof products==='undefined' || !products.length) return;
    const list = productsList();
    catalog.innerHTML = list.length ? list.map(p=>{
      const id=String(p.id),isSaved=saved.has(id);
      const img=p.image_url?'<img src="'+esc(p.image_url)+'" alt="'+esc(p.name)+'" loading="lazy" onerror="this.style.display=\'none\'">':'<div class="placeholder">🛍️</div>';
      return '<article class="product" data-product-card="'+esc(id)+'">'+img+'<button type="button" class="jumie-wish '+(isSaved?'saved':'')+'" data-jumie-wish="'+esc(id)+'" aria-label="Save to wishlist">'+(isSaved?'♥':'♡')+'</button><div class="info"><h3>'+esc(p.name)+'</h3><p class="price">'+money(p.price)+'</p><p class="stock">'+(Number(p.stock||0)>0?Number(p.stock)+' available':'Out of stock')+'</p><button class="add" type="button" data-id="'+esc(id)+'" '+(Number(p.stock||0)<=0?'disabled':'')+'>🛒 Add to Cart</button><button type="button" class="jumie-view" data-jumie-view="'+esc(id)+'">View details</button></div></article>';
    }).join('') : '<div class="jumie-empty">'+(wishlistOnly?'No saved products yet. Tap ♡ on a product to add it.':'No products found. Try another search or category.')+'</div>';
    const count=document.getElementById('jumieResultCount');
    if(count)count.textContent=list.length+' products';
  }
  function rerender(){decorate();if(typeof renderCart==='function')renderCart()}
  // Keep existing product search working with the new filter/sort controls.
  window.jumieCategory='all';
  document.querySelectorAll('[data-category]').forEach(btn=>btn.addEventListener('click',()=>{
    const value=String(btn.dataset.category||'all').toLowerCase();
    window.jumieCategory=({phones:'Phones & Tablets',fashion:'Fashion',beauty:'Beauty',home:'Home',electronics:'Electronics',all:'all'})[value]||btn.dataset.category||'all';
    wishlistOnly=false;
    decorate();
  }));
  tools.querySelectorAll('[data-jumie-filter]').forEach(b=>b.addEventListener('click',()=>{
    window.jumieCategory=b.dataset.jumieFilter;
    tools.querySelectorAll('[data-jumie-filter]').forEach(x=>x.classList.toggle('active',x===b));
    wishlistOnly=false;tools.querySelector('#jumieWishlistToggle').classList.remove('active');
    decorate();
  }));
  tools.querySelector('#jumieSort').addEventListener('change',e=>{sortMode=e.target.value;decorate()});
  tools.querySelector('#jumieWishlistToggle').addEventListener('click',e=>{
    wishlistOnly=!wishlistOnly;e.currentTarget.classList.toggle('active',wishlistOnly);
    e.currentTarget.textContent=wishlistOnly?'← All products':'♡ My Wishlist';decorate();
  });
  if($('search'))$('search').addEventListener('input',decorate);

  // Wishlist and product details use the existing Supabase product records.
  catalog.addEventListener('click',e=>{
    const wish=e.target.closest('[data-jumie-wish]');
    if(wish){const id=String(wish.dataset.jumieWish);saved.has(id)?saved.delete(id):saved.add(id);persist();decorate();return}
    const view=e.target.closest('[data-jumie-view]');
    if(view){
      const p=products.find(x=>String(x.id)===String(view.dataset.jumieView));if(!p)return;
      recent=[String(p.id),...recent.filter(x=>x!==String(p.id))].slice(0,8);persist();
      $('jumieProductDetails').innerHTML=(p.image_url?'<img src="'+esc(p.image_url)+'" alt="'+esc(p.name)+'">':'<div style="font-size:80px;text-align:center;padding:25px">🛍️</div>')+'<h2>'+esc(p.name)+'</h2><p style="font-size:21px;font-weight:800;color:#d45b00">'+money(p.price)+'</p><p>'+esc(p.description||'Product details available from JUMIE Store.')+'</p><p class="hint">'+(Number(p.stock||0)>0?Number(p.stock)+' in stock':'Out of stock')+'</p><button type="button" class="checkout" id="jumieModalAdd" '+(Number(p.stock||0)<=0?'disabled':'')+'>Add to Cart</button>';
      modal.classList.add('open');$('jumieModalAdd').onclick=()=>{add(p.id);modal.classList.remove('open')};
    }
  });
  modal.querySelector('.jumie-modal-close').onclick=()=>modal.classList.remove('open');
  modal.addEventListener('click',e=>{if(e.target===modal)modal.classList.remove('open')});

  // Persist cart and provide quantity controls while keeping the secure checkout endpoint intact.
  const originalAdd=add;
  add=function(id){
    const p=products.find(x=>String(x.id)===String(id));if(!p)return;
    const item=cart.find(x=>String(x.id)===String(id));
    if(item)item.qty++;else cart.push({id:p.id,name:p.name,price:Number(p.price||0),qty:1});
    persist();renderCart();
  };
  renderCart=function(){
    const count=cart.reduce((s,x)=>s+Number(x.qty||0),0),sum=cart.reduce((s,x)=>s+Number(x.price||0)*Number(x.qty||0),0);
    if($('count'))$('count').textContent=count;
    if($('total'))$('total').textContent=money(sum);
    const items=$('items');if(!items)return;
    items.innerHTML=cart.length?cart.map(x=>'<div class="jumie-cart-line"><div><b>'+esc(x.name)+'</b><div class="hint">'+money(x.price)+' each</div></div><div class="jumie-qty"><button type="button" data-jumie-minus="'+esc(x.id)+'">−</button><b>'+Number(x.qty)+'</b><button type="button" data-jumie-plus="'+esc(x.id)+'">＋</button></div><button type="button" class="jumie-remove" data-jumie-remove="'+esc(x.id)+'">Remove</button></div>').join(''):'<div class="jumie-empty">Your cart is empty. Add a product to get started.</div>';
  };
  $('items').addEventListener('click',e=>{
    const minus=e.target.closest('[data-jumie-minus]'),plus=e.target.closest('[data-jumie-plus]'),remove=e.target.closest('[data-jumie-remove]');
    const target=minus||plus||remove;if(!target)return;const id=String(target.dataset.jumieMinus||target.dataset.jumiePlus||target.dataset.jumieRemove);
    const item=cart.find(x=>String(x.id)===id);if(!item)return;
    if(remove)cart=cart.filter(x=>String(x.id)!==id);else{item.qty+=plus?1:-1;if(item.qty<1)cart=cart.filter(x=>String(x.id)!==id)}
    persist();renderCart();
  });
  // Restore cart saved by this enhanced storefront.
  try{const stored=JSON.parse(localStorage.getItem('jumieCart')||'null');if(Array.isArray(stored)&&stored.length)cart=stored}catch{}
  renderCart();
  // Existing page's load() fills the products array asynchronously. Observe its product status.
  const status=$('status');
  if(status)new MutationObserver(()=>{if(products&&products.length)decorate()}).observe(status,{childList:true,subtree:true,characterData:true});
  const oldRender=render;
  render=function(){decorate()};
  if($('search'))$('search').oninput=render;
  if(products&&products.length)decorate();
  // Remove the legacy wishlist injector after this replacement renderer is active.
  setTimeout(()=>{const old=document.getElementById('jumieSavedOnly');if(old){const parent=old.parentElement;parent.remove()}},0);
})();