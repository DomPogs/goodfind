'use strict';

let active = 'all';
let currentUser = null;
let apiOnline = false;
let extra = [];
const $ = selector => document.querySelector(selector);
const appBasePath = new URL('.', location.href).pathname.replace(/\/$/,'');
const schoolOptions = ['UM Panabo College','Aces Polytechnic College','Southern Davao National High School'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const price = value => '\u20B1' + Number(value).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});

async function request(url, options = {}) {
  const requestUrl = url.startsWith('/api/') ? `${appBasePath}${url}` : url;
  const response = await fetch(requestUrl, { credentials:'same-origin', ...options,
    headers:{ ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) } });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
const post = (url, body) => request(url,{method:'POST',body:JSON.stringify(body)});
const patch = (url, body) => request(url,{method:'PATCH',body:JSON.stringify(body)});
function notify(message) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(window._toast); window._toast = setTimeout(() => toast.classList.remove('show'), 2800);
}
function showModal(html) { $('#modal').innerHTML = html; $('#overlay').classList.add('open'); }
function closeModal() { $('#overlay').classList.remove('open'); }
function setListings(rows) { listings.splice(0,listings.length,...rows); }
function updateNav() {
  const avatar = $('#avatar');
  $('#signinbtn').hidden = Boolean(currentUser);
  $('#signupbtn').hidden = Boolean(currentUser);
  avatar.hidden = !currentUser;
  $('#adminbtn').hidden = currentUser?.role !== 'admin';
  if (currentUser) { avatar.textContent = currentUser.displayName.slice(0,2).toUpperCase(); avatar.title = currentUser.displayName; }
}

function render() {
  const query = $('#search').value.trim().toLowerCase();
  const tradeOnly = $('#tradeonly').checked;
  const location = $('#locationfilter').value;
  const sort = $('#sortby').value;
  const all = [...extra,...listings];
  const shown = all.filter(item =>
    (active === 'all' || active === 'new' || (active === 'trade' && item.trade) ||
      (active === 'physical' && item.kind === 'physical') || (active === 'digital' && item.kind === 'digital')) &&
    (!tradeOnly || item.trade) && (!location || item.place === location) && (!query || [item.title,item.seller,item.category,item.description,item.place].join(' ').toLowerCase().includes(query)));
  if (sort === 'low') shown.sort((a,b) => a.price-b.price);
  if (sort === 'high') shown.sort((a,b) => b.price-a.price);
  $('#heading').textContent = active === 'all' ? 'Picked for you' : active === 'trade' ? 'Open to trade' : active === 'new' ? 'Recently added' : active === 'physical' ? 'Physical goods' : 'Digital goods';
  $('#resultcount').textContent = `${shown.length} ${shown.length === 1 ? 'find' : 'finds'} ready for a new home`;
  $('#grid').innerHTML = shown.length ? shown.map(item => `<article class="card">
    <div class="art" style="background:${esc(item.art)}"><span class="badge">${item.kind === 'physical' ? 'PHYSICAL' : 'DIGITAL'} · ${esc(item.category.toUpperCase())}</span>
    <button class="heart" aria-label="Save ${esc(item.title)}" onclick="saveItem(this)">♡</button>${item.photoData?`<img class="item-photo" src="${esc(item.photoData)}" alt="Photo of ${esc(item.title)}">`:`<span class="emoji">${esc(item.emoji)}</span><span class="artnote">${esc(item.note)}</span>`}</div>
    <div class="cardbody"><div class="sellerline"><span class="mini">${esc(item.initial)}</span>${esc(item.seller)} ${item.verified ? '<span class="verified">✓</span>' : ''} · ${esc(item.condition)}</div>
    <h3 title="${esc(item.title)}">${esc(item.title)}</h3><p class="sub">${esc(item.description.slice(0,65))}${item.description.length>65?'…':''}</p>
    <div class="cardfoot"><span class="price">${price(item.price)}</span>${item.trade?'<span class="tradeTag">↔ Open to trade</span>':''}</div>
    <div class="location">${schoolOptions.includes(item.place)?'School':'⌖'} · ${esc(item.place)}</div><div style="display:flex;gap:8px;margin-top:12px">
    <button class="primary" style="flex:1;padding:9px 8px;font-size:11px" onclick="openDetail(${Number(item.id)})">View item</button>
    ${item.trade?`<button class="filterbtn" style="height:34px;padding:0 9px;color:var(--green);font-size:11px" onclick="openTrade(${Number(item.id)})">Offer trade</button>`:''}</div></div></article>`).join('') : '<div class="empty"><strong>No finds yet</strong>Try a different search or category.</div>';
}
function saveItem(button) { const saved = button.classList.toggle('saved'); button.textContent = saved ? '♥' : '♡'; notify(saved ? 'Saved to your favorites.' : 'Removed from your favorites.'); }

function authPage(mode) { location.href = `${appBasePath}/auth/?mode=${mode}`; }
function openAccount() {
  if (currentUser) return accountPanel();
  authPage('login');
}
function openSignup() { authPage('signup'); }
function accountPanel() {
  showModal(`<div class="modalhead"><div><h2>${esc(currentUser.displayName)}</h2><p>${esc(currentUser.email)}</p></div><button class="close" onclick="closeModal()">×</button></div>
    <div class="tradeoffer"><div class="yougive">SELLER PAYOUTS</div><p style="font-size:13px;line-height:1.6;color:#657168">${currentUser.payoutsConnected?'Your Stripe payouts account is connected.':'Connect a Stripe account to receive sale payouts.'}</p>
    ${currentUser.payoutsConnected?'':`<div class="field"><label>Two-letter payout country code</label><input id="country" maxlength="2" pattern="[A-Za-z]{2}" placeholder="e.g. US"></div><button class="filterbtn" style="width:100%" onclick="startPayoutSetup()">Set up payouts with Stripe</button>`}</div>
    <button class="filterbtn" style="width:100%;margin-top:12px" onclick="signOut()">Sign out</button>`);
}
async function startPayoutSetup() {
  try { const data = await post('/api/payments/connect/onboard',{country:$('#country').value}); location.href = data.url; }
  catch (error) { notify(error.message); }
}
async function signOut() {
  try { await post('/api/auth/logout',{}); currentUser = null; updateNav(); closeModal(); notify('You’re signed out.'); }
  catch (error) { notify(error.message); }
}

async function openAdmin() {
  if (!currentUser || currentUser.role !== 'admin') { notify('Admin access is required.'); return; }
  try {
    const {counts, listings:rows} = await request('/api/admin/overview');
    showModal(`<div class="modalhead"><div><div class="eyebrow">GOODFIND ADMIN</div><h2>Marketplace overview</h2><p>Review activity and moderate listings.</p></div><button class="close" onclick="closeModal()">×</button></div>
      <div class="adminstats"><div><strong>${counts.members}</strong><span>Members</span></div><div><strong>${counts.activeListings}</strong><span>Active listings</span></div><div><strong>${counts.hiddenListings}</strong><span>Hidden listings</span></div><div><strong>${counts.orders}</strong><span>Orders</span></div></div>
      <div class="adminlisthead"><strong>Listings</strong><span>Latest 100</span></div>
      ${rows.length?rows.map(item=>`<div class="adminlisting"><div class="adminlistinginfo"><strong>${esc(item.title)}</strong><span>${esc(item.seller)} · ${price(item.price)} · ${esc(item.status)}</span></div><button class="filterbtn" onclick="moderateListing(${Number(item.id)},'${item.status==='active'?'hidden':'active'}')">${item.status==='active'?'Hide':'Restore'}</button></div>`).join(''):'<div class="empty" style="padding:30px 10px"><strong>No listings</strong>Listings will appear here.</div>'}`);
  } catch(error) { notify(error.message); }
}
async function moderateListing(id,status) {
  try {
    await patch(`/api/admin/listings/${id}`,{status});
    extra = extra.filter(item=>Number(item.id)!==Number(id));
    if (status === 'hidden') setListings(listings.filter(item=>Number(item.id)!==Number(id)));
    else { const {listings:rows}=await request('/api/listings'); setListings(rows); }
    render(); await openAdmin(); notify(status==='hidden'?'Listing hidden from the marketplace.':'Listing restored to the marketplace.');
  } catch(error) { notify(error.message); }
}

function openSell() {
  if (!currentUser) { openAccount(); notify('Sign in to publish a listing.'); return; }
  showModal(`<div class="modalhead"><div><h2>List something good</h2><p>Add an item for sale, trade, or both.</p></div><button class="close" onclick="closeModal()">×</button></div>
  <form id="sellform"><div class="field"><label>What are you listing?</label><input name="title" required maxlength="100" placeholder="e.g. Handmade ceramic bowl"></div>
  <div class="field"><label>Type</label><div class="choice" role="radiogroup" aria-label="Listing type"><label class="selected"><input type="radio" name="kind" value="physical" checked> Physical good</label><label><input type="radio" name="kind" value="digital"> Digital good</label></div></div>
  <div class="field"><label>Category</label><select name="category"><option>Home & living</option><option>Art & prints</option><option>Tech</option><option>Gaming</option><option>Photography</option><option>Accessories</option><option>Digital art</option><option>Templates</option><option>Music</option><option>Other</option></select></div>
  <div class="field"><label>Price (PHP)</label><input name="price" type="number" min="1" max="1000000" step="0.01" required placeholder="0.00"></div>
  <div class="field"><label for="itemPhoto">Item photo <span class="optional-label">Optional</span></label><div class="photo-field-layout"><div id="photoPreview" class="photo-preview" aria-live="polite" hidden><div class="photo-preview-head"><span id="photoPreviewName">Selected photo</span><button type="button" id="removePhoto" class="photo-remove">Remove</button></div><div class="photo-preview-image"><img id="photoPreviewImage" alt="Preview of the selected item photo"></div></div><div class="photo-controls"><div class="photo-upload"><input id="itemPhoto" name="photo" type="file" accept="image/jpeg,image/png,image/webp" class="photo-input"><small class="field-help">JPG, PNG, or WebP · up to 8 MB</small></div></div></div></div>
  <div class="field"><label>Condition or delivery</label><input name="condition" maxlength="40" placeholder="Good, new, instant download..."></div>
  <div class="field" id="schoolfield"><label>Which school community is this item for?</label><select name="place" required><option value="" disabled selected>Choose a school</option><option>UM Panabo College</option><option>Aces Polytechnic College</option><option>Southern Davao National High School</option></select></div>
  <div class="field"><label>Details</label><textarea name="description" required maxlength="2000" placeholder="Condition, what's included, delivery details..."></textarea></div>
  <div class="field"><label><input type="checkbox" name="trade" style="accent-color:var(--green)"> Open to trade offers</label></div><button class="primary">Publish listing</button></form>`);
  const schoolField = $('#schoolfield');
  $('#itemPhoto').addEventListener('change', () => {
    const file = $('#itemPhoto').files[0]; const preview = $('#photoPreview');
    if (!file) { preview.hidden=true; return; }
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 8*1024*1024) { $('#itemPhoto').value=''; preview.hidden=true; notify('Choose a JPG, PNG, or WebP photo under 8 MB.'); return; }
    const previewImage=$('#photoPreviewImage');const previewUrl=URL.createObjectURL(file);previewImage.onload=()=>URL.revokeObjectURL(previewUrl);previewImage.onerror=()=>notify('The selected file could not be previewed. Try another JPG, PNG, or WebP image.');$('#photoPreviewName').textContent=file.name;previewImage.src=previewUrl;preview.hidden=false;
  });
  $('#removePhoto').addEventListener('click',()=>{$('#itemPhoto').value='';$('#photoPreviewImage').removeAttribute('src');$('#photoPreview').hidden=true;});
  document.querySelectorAll('#sellform input[name="kind"]').forEach(radio => radio.addEventListener('change', () => {
    document.querySelectorAll('#sellform .choice label').forEach(label => label.classList.toggle('selected',label.querySelector('input').checked));
    const physical = $('#sellform input[name="kind"]:checked').value === 'physical';
    schoolField.hidden = !physical;
    schoolField.querySelector('select').required = physical;
  }));
  $('#sellform').onsubmit = async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const kind = form.get('kind');
    const draft = {title:form.get('title'),kind,category:form.get('category'),price:Number(form.get('price')),
      condition:form.get('condition') || (kind==='digital'?'Instant download':'Good'),place:form.get('place'),description:form.get('description'),trade:form.has('trade')};
    try {
      const photo=$('#itemPhoto').files[0]; if (photo) draft.photoData=await compressPhoto(photo);
      const result = await post('/api/listings',draft); listings.unshift(result.listing); closeModal(); active='all'; selectTab('all'); render(); notify('Your listing is live.');
    } catch (error) { notify(error.message); }
  };
}
function compressPhoto(file) {
  return (async()=>{
    let image;
    if(window.createImageBitmap){try{image=await createImageBitmap(file);}catch{}}
    if(!image){
      const source=await readPhotoData(file);
      image=await new Promise((resolve,reject)=>{const element=new Image();element.onload=()=>resolve(element);element.onerror=()=>reject(new Error('This image could not be decoded. Try saving it as a JPG, PNG, or WebP photo.'));element.src=source;});
    }
    const scale=Math.min(1,1200/Math.max(image.width,image.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);if(image.close)image.close();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.82));if(!blob)throw new Error('Could not process that photo.');return readPhotoData(blob);
  })();
}
function readPhotoData(file) { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read that photo.'));reader.readAsDataURL(file);}); }
function selectTab(kind) { document.querySelectorAll('.tab').forEach(button => button.classList.toggle('active',button.dataset.kind===kind)); active=kind; }

function openDetail(id) {
  const item = [...extra,...listings].find(row=>Number(row.id)===Number(id)); if (!item) return;
  const memberItem = Boolean(item.sellerId);
  showModal(`<div class="modalhead"><div><div class="eyebrow">${esc(item.kind)} · ${esc(item.category)}</div><h2>${esc(item.title)}</h2><p>Listed by ${esc(item.seller)} · ${esc(item.condition)}</p></div><button class="close" onclick="closeModal()">×</button></div>
    <div class="art detail-art" style="height:220px;border-radius:14px;background:${esc(item.art)};margin-bottom:18px">${item.photoData?`<img class="item-photo" src="${esc(item.photoData)}" alt="Photo of ${esc(item.title)}">`:`<span class="emoji">${esc(item.emoji)}</span><span class="artnote">${esc(item.note)}</span>`}</div>
    <p style="font-size:13px;line-height:1.7;color:#667269">${esc(item.description)}</p><div class="detailprice">${price(item.price)} <small>${schoolOptions.includes(item.place)?`School: ${esc(item.place)}`:esc(item.place)}</small></div>
    ${memberItem?'<button class="primary" onclick="startCheckout('+Number(item.id)+')">Buy this item</button><button class="filterbtn" style="width:100%;margin-top:9px" onclick="openConversation('+Number(item.id)+','+Number(item.sellerId)+')">Message seller</button>':'<button class="primary" disabled title="Member checkout becomes available after a member lists this item">Member checkout unavailable on sample listings</button>'}
    ${item.trade?`<button class="filterbtn" style="width:100%;margin-top:9px" onclick="openTrade(${Number(item.id)})">↔ Make a trade offer</button>`:''}`);
}
async function startCheckout(listingId) {
  if (!currentUser) { closeModal(); openAccount(); notify('Sign in before checkout.'); return; }
  try { const result = await post('/api/payments/checkout',{listingId}); location.href=result.url; }
  catch (error) { notify(error.message); }
}

async function openTrade(listingId) {
  const target = [...extra,...listings].find(item=>Number(item.id)===Number(listingId)); if (!target) return;
  if (!currentUser) { closeModal(); openAccount(); notify('Sign in to make a trade offer.'); return; }
  const ownListings = listings.filter(item=>item.sellerId===currentUser.id && item.trade && item.status==='active' && Number(item.id)!==Number(target.id));
  if (!target.sellerId) { notify('Sample listings are view-only. Member listings can receive real offers.'); return; }
  showModal(`<div class="modalhead"><div><h2>Make a trade offer</h2><p>Offer an item you own for <strong>${esc(target.title)}</strong>.</p></div><button class="close" onclick="closeModal()">×</button></div>
    ${ownListings.length?`<div class="tradeoffer"><div class="yougive">YOU OFFER</div><select id="tradeitem">${ownListings.map(item=>`<option value="${item.id}">${esc(item.title)} · ${price(item.price)}</option>`).join('')}</select><div class="yougive" style="margin-top:15px">YOU RECEIVE</div><div class="itemname">${esc(target.title)} <span style="color:#79867c;font-weight:500">· ${price(target.price)}</span></div></div>
    <div class="field"><label>Add a note</label><textarea id="tradenote" maxlength="500" placeholder="Share why this feels like a fair trade..."></textarea></div><button class="primary" onclick="sendOffer(${Number(target.id)})">Send trade offer</button>`:'<div class="empty" style="padding:30px 10px"><strong>List an item first</strong>Trade offers use one of your active listings.</div><button class="primary" onclick="closeModal();openSell()">List an item</button>'}`);
}
async function sendOffer(targetId) {
  try {
    await post('/api/trades',{listingId:targetId,offeredListingId:Number($('#tradeitem').value),note:$('#tradenote').value});
    closeModal(); notify('Trade offer sent.');
  } catch (error) { notify(error.message); }
}
async function openOffers() {
  if (!currentUser) { openAccount(); notify('Sign in to view trade offers.'); return; }
  try {
    const {offers} = await request('/api/trades');
    showModal(`<div class="modalhead"><div><h2>Trade offers</h2><p>Incoming offers and offers you’ve sent.</p></div><button class="close" onclick="closeModal()">×</button></div>
      ${offers.length?offers.map(offer=>`<div class="tradeoffer"><div style="display:flex;gap:10px;align-items:center"><div><strong style="font-size:13px">${esc(offer.offeredTitle)} for ${esc(offer.requestedTitle)}</strong><div class="yougive" style="margin-top:5px">${price(offer.offeredPrice)} offered · ${price(offer.requestedPrice)} requested · ${offer.isIncoming?'From '+esc(offer.sender):'To '+esc(offer.receiver)}</div>${offer.note?`<p style="font-size:12px;margin:9px 0 0">“${esc(offer.note)}”</p>`:''}</div><span class="tradeTag">${esc(offer.status)}</span></div>
      ${offer.status==='pending'&&offer.isIncoming?`<div style="display:flex;gap:8px;margin-top:12px"><button class="primary" onclick="answerOffer(${offer.id},'accepted')">Accept trade</button><button class="filterbtn" onclick="answerOffer(${offer.id},'declined')">Decline</button></div>`:''}
      ${offer.status==='pending'&&!offer.isIncoming?`<button class="filterbtn" style="margin-top:12px" onclick="answerOffer(${offer.id},'withdrawn')">Withdraw offer</button>`:''}</div>`).join(''):'<div class="empty" style="padding:35px 10px"><strong>No offers yet</strong>Trade offers for your listings will appear here.</div>'}`);
  } catch (error) { notify(error.message); }
}
async function answerOffer(id,status) {
  try { await patch(`/api/trades/${id}`,{status}); openOffers(); notify(status==='accepted'?'Trade accepted. Both listings are marked traded.':`Offer ${status}.`); }
  catch (error) { notify(error.message); }
}

async function openMessages() {
  if (!currentUser) { openAccount(); notify('Sign in to view messages.'); return; }
  try {
    const {conversations} = await request('/api/messages');
    showModal(`<div class="modalhead"><div><h2>Messages</h2><p>Private conversations about member listings.</p></div><button class="close" onclick="closeModal()">×</button></div>
      ${conversations.length?conversations.map(thread=>`<button class="filterbtn" style="width:100%;height:auto;text-align:left;padding:13px;margin:5px 0;display:flex;align-items:center;gap:12px" onclick="openConversation(${thread.listingId},${thread.otherId})"><span style="font-size:23px">${esc(thread.emoji)}</span><span><strong>${esc(thread.title)}</strong><small style="display:block;color:#839087;margin-top:3px">${esc(thread.otherName)}</small></span></button>`).join(''):'<div class="empty" style="padding:35px 10px"><strong>No messages yet</strong>Open a member listing to message its seller.</div>'}`);
  } catch (error) { notify(error.message); }
}
async function openConversation(listingId, otherId) {
  if (!currentUser) { openAccount(); notify('Sign in to message a member.'); return; }
  const item = [...extra,...listings].find(row=>Number(row.id)===Number(listingId)); if (!item) return;
  if (!item.sellerId) { notify('Sample listings are view-only.'); return; }
  try {
    if (currentUser.id===item.sellerId&&!otherId) { notify('Open a buyer thread from your Messages list.'); return; }
    const recipientId=currentUser.id===item.sellerId?Number(otherId):Number(item.sellerId);
    const query=currentUser.id===item.sellerId?`?with=${recipientId}`:'';
    const {messages} = await request(`/api/listings/${listingId}/messages${query}`);
    showModal(`<div class="modalhead"><div><h2>Message about ${esc(item.title)}</h2><p>Private conversation between members.</p></div><button class="close" onclick="closeModal()">×</button></div>
      <div id="message-list" style="max-height:300px;overflow:auto;background:#f6f8f4;border-radius:12px;padding:12px">${messages.length?messages.map(message=>`<div style="max-width:85%;margin:8px 0 8px ${message.mine?'auto':'0'};padding:10px 12px;border-radius:12px;background:${message.mine?'#e5f2e9':'white'};font-size:12px;line-height:1.5"><small style="display:block;color:#88948b;margin-bottom:4px">${message.mine?'You':esc(message.sender)}</small>${esc(message.body)}</div>`).join(''):'<p style="text-align:center;color:#89938c;font-size:12px">Start the conversation with a message.</p>'}</div>
      <form id="messageform" style="display:flex;gap:8px;margin-top:12px"><input name="body" required maxlength="2000" placeholder="Write a message..." style="flex:1;min-width:0;border:1px solid var(--line);border-radius:10px;padding:11px"><button class="primary">Send</button></form><button class="sort" onclick="openConversation(${listingId},${recipientId})">Refresh messages</button>`);
    $('#messageform').onsubmit = async event => { event.preventDefault(); const content=new FormData(event.currentTarget).get('body'); try { await post(`/api/listings/${listingId}/messages`,{body:content,recipientId}); openConversation(listingId,recipientId); } catch(error) { notify(error.message); } };
    $('#message-list').scrollTop=$('#message-list').scrollHeight;
  } catch (error) { notify(error.message); }
}

function toggleFilters() { const panel=$('#filterpanel'); panel.style.display=panel.style.display==='flex'?'none':'flex'; }
$('#tabs').addEventListener('click',event=>{const button=event.target.closest('.tab');if(!button)return;selectTab(button.dataset.kind);render();});
document.querySelectorAll('.navlinks [data-kind]').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();document.querySelector(`#tabs [data-kind="${link.dataset.kind}"]`).click();$('#discover').scrollIntoView({behavior:'smooth'});}));
$('#search').addEventListener('input',render); $('#tradeonly').addEventListener('change',render); $('#locationfilter').addEventListener('change',render); $('#sortby').addEventListener('change',render);
document.addEventListener('keydown',event=>{if(event.key==='/'&&document.activeElement.tagName!=='INPUT'){event.preventDefault();$('#search').focus();}if(event.key==='Escape')closeModal();});

async function boot() {
  try {
    await request('/api/health'); apiOnline=true;
    const [account,market] = await Promise.all([request('/api/auth/me'),request('/api/listings')]);
    currentUser=account.user; setListings(market.listings); updateNav(); render();
  } catch { apiOnline=false; updateNav(); }
  const params=new URLSearchParams(location.search);
  if (params.get('payment')==='success') notify('Payment submitted. The order updates after Stripe confirms it.');
  if (params.get('payment')==='cancel') {
    if (currentUser&&params.get('order_id')) { try { await post('/api/payments/cancel',{orderId:params.get('order_id')}); } catch {} }
    notify('Checkout was canceled. The listing is available again.');
  }
  if (params.get('payout_setup')==='return'&&currentUser) {
    try { await request('/api/payments/connect/status'); const account=await request('/api/auth/me');currentUser=account.user;updateNav();notify(currentUser.payoutsConnected?'Payout setup is complete.':'Stripe may need more information before payouts are enabled.'); } catch(error) { notify(error.message); }
  }
}

render();
boot();
