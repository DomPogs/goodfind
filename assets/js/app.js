'use strict';

let active = 'all';
let currentUser = null;
let apiOnline = false;
let extra = [];
const $ = selector => document.querySelector(selector);
const appBasePath = new URL('.', location.href).pathname.replace(/\/$/,'');
const schoolOptions = ['UM Panabo College','Aces Polytechnic College','Southern Davao National High School'];
const schoolMapPoints = {
  'UM Panabo College':{lat:7.30477,lng:125.67898},
  'Aces Polytechnic College':{lat:7.33192,lng:125.66064},
  'Southern Davao National High School':{lat:7.33216,lng:125.65722}
};
let listingsMap=null, mapMarkers=null, leafletPromise=null, lastShownListings=[];
let locationWatchId=null, userLocationMarker=null, userAccuracyCircle=null, firstLocationFix=true;
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
function showModal(html) { $('#modal').classList.remove('chat-modal','detail-modal','sell-modal'); $('#overlay').classList.remove('chat-open'); $('#modal').innerHTML = html; $('#overlay').classList.add('open'); }
function showChat(html) { $('#modal').innerHTML = html; $('#modal').classList.remove('detail-modal'); $('#modal').classList.add('chat-modal'); $('#overlay').classList.add('open','chat-open'); }
function closeModal() { $('#overlay').classList.remove('open','chat-open'); $('#modal').classList.remove('chat-modal','sell-modal'); }
function setListings(rows) { listings.splice(0,listings.length,...rows); }
function isOwnListing(item) { return Boolean(currentUser && item?.sellerId && Number(currentUser.id)===Number(item.sellerId)); }
function messageReadKey(listingId,otherId) { return `goodfind-message-read:${currentUser?.id}:${listingId}:${otherId}`; }
function updateMessagesBadge(conversations) {
  if (!currentUser) return;
  let unread=0;
  for (const thread of conversations) {
    if (Number(thread.lastSenderId)===Number(currentUser.id)) continue;
    let readId=0; try { readId=Number(localStorage.getItem(messageReadKey(thread.listingId,thread.otherId))||0); } catch {}
    if (Number(thread.lastId)>readId) unread++;
  }
  const badge=$('#messages-badge'); badge.hidden=unread===0; badge.textContent=unread>9?'9+':String(unread);
  const launcher=$('#messages-fab'); launcher.classList.toggle('has-unread',unread>0);
  launcher.setAttribute('aria-label',unread?`Messages, ${unread} unread conversations`:'Messages');
}
async function refreshMessagesBadge() {
  if (!currentUser) return;
  try { const {conversations}=await request('/api/messages'); updateMessagesBadge(conversations); } catch {}
}
function markConversationRead(listingId,otherId,messages) {
  const latest=messages.reduce((max,message)=>Math.max(max,Number(message.id)||0),0);
  try { localStorage.setItem(messageReadKey(listingId,otherId),String(latest)); } catch {}
  refreshMessagesBadge();
}
function updateNav() {
  const avatar = $('#avatar');
  $('#signinbtn').hidden = Boolean(currentUser);
  $('#signupbtn').hidden = Boolean(currentUser);
  avatar.hidden = !currentUser;
  $('#adminbtn').hidden = currentUser?.role !== 'admin';
  $('#messages-fab').hidden = !currentUser;
  if (currentUser) {
    avatar.title = currentUser.displayName;
    avatar.innerHTML = currentUser.profilePhoto ? `<img src="${esc(currentUser.profilePhoto)}" alt="">` : esc(currentUser.displayName.slice(0,2).toUpperCase());
  }
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
  lastShownListings=shown;
  $('#heading').textContent = active === 'all' ? 'Picked for you' : active === 'trade' ? 'Open to trade' : active === 'new' ? 'Recently added' : active === 'physical' ? 'Physical goods' : 'Digital goods';
  $('#resultcount').textContent = `${shown.length} ${shown.length === 1 ? 'find' : 'finds'} ready for a new home`;
  $('#grid').innerHTML = shown.length ? shown.map(item => `<article class="card">
    <div class="art" style="background:${esc(item.art)}">
      <span class="badge"><span>${item.kind === 'physical' ? 'Physical' : 'Digital'}</span><span class="badge-divider" aria-hidden="true">&#183;</span><span class="badge-category">${esc(item.category)}</span></span>
      <button class="heart" aria-label="Save ${esc(item.title)}" onclick="saveItem(this)">&#9825;</button>
      ${item.photoData?`<img class="item-photo" src="${esc(item.photoData)}" alt="Photo of ${esc(item.title)}">`:`<span class="emoji">${esc(item.emoji)}</span><span class="artnote">${esc(item.note)}</span>`}
      ${item.photoCount>1?`<span class="photo-count-badge">${item.photoCount} photos</span>`:''}
    </div>
    <div class="cardbody">
      <div class="sellerline"><span class="mini" aria-hidden="true">${esc(item.initial)}</span><span class="sellername">${esc(item.seller)}</span>${item.verified ? '<span class="verified" title="Verified member" aria-label="Verified member">&#10003;</span>' : ''}</div>
      <h3 title="${esc(item.title)}">${esc(item.title)}</h3>
      <p class="sub">${esc(item.description.slice(0,90))}${item.description.length>90?'&#8230;':''}</p>
      <div class="card-detail-row">
        <div class="location" title="${esc(item.place)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"></path><circle cx="12" cy="10" r="2.5"></circle></svg><span>${esc(item.place)}</span></div>
        <span class="condition-tag" title="${esc(item.condition)}">${esc(item.condition)}</span>
      </div>
      <div class="cardfoot"><span class="price">${price(item.price)}</span>${item.trade?'<span class="tradeTag"><span aria-hidden="true">&#8596;</span> Open to trade</span>':''}</div>
      <div class="card-actions"><button class="primary card-action" onclick="openDetail(${Number(item.id)})">View item</button>${item.trade&&!isOwnListing(item)?`<button class="filterbtn card-trade-action" onclick="openTrade(${Number(item.id)})">Offer trade</button>`:''}</div>
    </div>
  </article>`).join('') : '<div class="empty"><strong>No finds yet</strong>Try a different search or category.</div>';
  if (listingsMap && !$('#mapview').hidden) refreshMapMarkers();
}
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve,reject) => {
    const script=document.createElement('script');
    script.src='https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
    script.crossOrigin=''; script.onload=resolve; script.onerror=()=>reject(new Error('Map library could not load. Check your internet connection.'));
    document.head.append(script);
  });
  return leafletPromise;
}
async function toggleMapView() {
  const mapView=$('#mapview'), button=$('#maptoggle');
  const opening=mapView.hidden;
  mapView.hidden=!opening; $('#grid').hidden=opening;
  button.textContent=opening?'Show list':'Show map'; button.setAttribute('aria-pressed',String(opening));
  if (!opening) { if(locationWatchId!==null) stopLiveLocation(); return; }
  try {
    await loadLeaflet();
    if (!listingsMap) {
      listingsMap=L.map('listings-map').setView([7.308,125.683],11);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'}).addTo(listingsMap);
      mapMarkers=L.layerGroup().addTo(listingsMap);
    }
    refreshMapMarkers();
    showPanaboCity();
    setTimeout(()=>listingsMap.invalidateSize(),100);
  } catch(error) { notify(error.message); }
}
function refreshMapMarkers() {
  if (!listingsMap||!mapMarkers) return;
  mapMarkers.clearLayers();
  const bounds=[];
  for (const [school,point] of Object.entries(schoolMapPoints)) {
    const matches=lastShownListings.filter(item=>item.place===school);
    if (!matches.length) continue;
    const marker=L.marker([point.lat,point.lng]).addTo(mapMarkers);
    const items=matches.slice(0,5).map(item=>`<li><strong>${esc(item.title)}</strong> ? ${price(item.price)}</li>`).join('');
    marker.bindPopup(`<div class="map-popup"><strong>${esc(school)}</strong><span>${matches.length} ${matches.length===1?'listing':'listings'}</span><ul>${items}</ul>${matches.length>5?`<small>and ${matches.length-5} more</small>`:''}</div>`);
    bounds.push([point.lat,point.lng]);
  }
  showPanaboCity();
}
function showPanaboCity() {
  if (!listingsMap) return;
  listingsMap.fitBounds([[7.19,125.54],[7.45,125.82]],{padding:[18,18]});
  $('#location-status').textContent=locationWatchId===null?'Showing the full Panabo City area.':'Live location is updating.';
}
function toggleLiveLocation() {
  if (locationWatchId!==null) { stopLiveLocation(); return; }
  if (!navigator.geolocation) { notify('Location is not available in this browser.'); return; }
  firstLocationFix=true;
  $('#locate-button').textContent='Finding location?';
  $('#location-status').textContent='Waiting for browser location permission?';
  locationWatchId=navigator.geolocation.watchPosition(position=>{
    const {latitude,longitude,accuracy}=position.coords;
    const point=[latitude,longitude];
    if (!userLocationMarker) userLocationMarker=L.circleMarker(point,{radius:8,color:'#fff',weight:3,fillColor:'#2878e5',fillOpacity:1}).addTo(listingsMap);
    else userLocationMarker.setLatLng(point);
    if (!userAccuracyCircle) userAccuracyCircle=L.circle(point,{radius:Math.min(accuracy||0,1500),color:'#2878e5',weight:1,fillColor:'#2878e5',fillOpacity:.12}).addTo(listingsMap);
    else userAccuracyCircle.setLatLng(point).setRadius(Math.min(accuracy||0,1500));
    if (firstLocationFix) { listingsMap.setView(point,15); firstLocationFix=false; }
    $('#locate-button').textContent='Stop live location';
    $('#location-status').textContent=`Live location updating ? accuracy about ${Math.round(accuracy)} m.`;
  },error=>{
    stopLiveLocation();
    const messages={1:'Location permission was denied. Allow it in your browser settings to use live location.',2:'Your location could not be determined. Check device location services and try again.',3:'Location request timed out. Try again.'};
    $('#location-status').textContent='Live location is off.';
    notify(messages[error.code]||'Could not get your location.');
  },{enableHighAccuracy:true,maximumAge:5000,timeout:20000});
}
function stopLiveLocation() {
  if (locationWatchId!==null) navigator.geolocation.clearWatch(locationWatchId);
  locationWatchId=null;
  if (listingsMap && userLocationMarker) listingsMap.removeLayer(userLocationMarker);
  if (listingsMap && userAccuracyCircle) listingsMap.removeLayer(userAccuracyCircle);
  userLocationMarker=null; userAccuracyCircle=null;
  $('#locate-button').textContent='Use my location';
  $('#location-status').textContent='Live location paused. It is not saved to your Goodfind account.';
}
function saveItem(button) { const saved = button.classList.toggle('saved'); button.textContent = saved ? '♥' : '♡'; notify(saved ? 'Saved to your favorites.' : 'Removed from your favorites.'); }

function authPage(mode) { location.href = `${appBasePath}/auth/?mode=${mode}`; }
function openAccount() {
  if (currentUser) return accountPanel();
  authPage('login');
}
function openSignup() { authPage('signup'); }
function accountPanel() {
  const idStatus=currentUser.idVerificationStatus||'unsubmitted';
  const idStatusText={unsubmitted:'Not submitted',pending:'Waiting for admin review',verified:'School ID verified',rejected:'Photo rejected — upload a new one'}[idStatus]||'Not submitted';
  showModal(`<div class="modalhead"><div><div class="eyebrow">YOUR ACCOUNT</div><h2>Account settings</h2><p>Manage your profile and seller payouts.</p></div><button class="close" onclick="closeModal()">×</button></div>
    <div class="profile-summary"><div class="profile-avatar">${currentUser.profilePhoto?`<img src="${esc(currentUser.profilePhoto)}" alt="Profile photo">`:esc(currentUser.displayName.slice(0,2).toUpperCase())}</div><div class="profile-summary-copy"><strong>${esc(currentUser.displayName)}</strong><span>${esc(currentUser.email)}</span><small>${esc(currentUser.contactNo||'Add your contact number')} · ${esc(currentUser.schoolId||'Add your school ID')}</small></div><button class="filterbtn profile-edit-btn" onclick="editProfile()">Edit profile</button></div>
    <div class="id-verification-status ${esc(idStatus)}"><strong>School ID: ${esc(idStatusText)}</strong><small>${idStatus==='verified'?'Your ID number was reviewed by an admin.':idStatus==='pending'?'Your photo will be deleted after review.':idStatus==='rejected'?'Edit your profile to submit another clear photo.':'Edit your profile to submit a photo for review.'}</small></div>
    <div class="tradeoffer"><div class="yougive">SELLER PAYOUTS</div><p style="font-size:13px;line-height:1.6;color:#657168">${currentUser.payoutsConnected?'Your Stripe payouts account is connected.':'Connect a Stripe account to receive sale payouts.'}</p>
    ${currentUser.payoutsConnected?'':`<div class="field"><label>Two-letter payout country code</label><input id="country" maxlength="2" pattern="[A-Za-z]{2}" placeholder="e.g. US"></div><button class="filterbtn" style="width:100%" onclick="startPayoutSetup()">Set up payouts with Stripe</button>`}</div>
    <div class="account-signout"><div class="account-signout-copy"><span class="signout-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M10 4H5v16h5M14 8l4 4-4 4M8 12h10"/></svg></span><span><strong>Sign out</strong><small>End your Goodfind session on this device.</small></span></div><button class="signout-btn" onclick="signOut()" aria-label="Sign out of Goodfind">Sign out<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10 5h8v14h-8M4 12h12m-4-4 4 4-4 4"/></svg></button></div>`);
}
let profilePhotoDraft = null;
let schoolIdPhotoDraft = null;
function editProfile() {
  profilePhotoDraft = currentUser.profilePhoto || null;
  schoolIdPhotoDraft = null;
  showModal(`<div class="modalhead"><div><div class="eyebrow">YOUR ACCOUNT</div><h2>Edit profile</h2><p>Update the information other members see.</p></div><button class="close" onclick="accountPanel()">×</button></div>
    <form id="profileform">
      <div class="profile-photo-editor"><div class="profile-avatar profile-avatar-large" id="profile-preview">${profilePhotoDraft?`<img src="${esc(profilePhotoDraft)}" alt="Profile photo preview">`:esc(currentUser.displayName.slice(0,2).toUpperCase())}</div><div class="profile-photo-actions"><label class="profile-upload" for="profilePhotoFile">Choose photo</label><input id="profilePhotoFile" type="file" accept="image/jpeg,image/png,image/webp" hidden><button type="button" class="profile-remove" id="removeProfilePhoto" ${profilePhotoDraft?'':'hidden'}>Remove photo</button><small>JPG, PNG, or WebP · up to 8 MB</small></div></div>
      <div class="field"><label for="profileName">Full name</label><input id="profileName" name="displayName" value="${esc(currentUser.displayName)}" maxlength="60" required autocomplete="name"></div>
      <div class="field"><label for="profileSchoolId">School ID</label><input id="profileSchoolId" name="schoolId" value="${esc(currentUser.schoolId)}" maxlength="40" required></div>
      <div class="field"><label for="schoolIdPhotoFile">School ID verification photo</label><label class="id-photo-pick" for="schoolIdPhotoFile">Choose a photo or take one</label><input class="id-photo-input" id="schoolIdPhotoFile" type="file" accept="image/*" capture="environment"><div class="id-photo-preview" id="school-id-preview" hidden></div><small class="profile-help">${esc(currentUser.idVerificationStatus==='verified'?'A new photo is needed only if you change your ID number.':'Submit a clear photo showing your name and ID number. Images are deleted after admin review.')}</small></div>
      <div class="field"><label for="profileContact">Contact number</label><input id="profileContact" name="contactNo" value="${esc(currentUser.contactNo)}" maxlength="25" minlength="7" required autocomplete="tel"></div>
      <div class="field"><label>Email address</label><input value="${esc(currentUser.email)}" disabled><small class="profile-help">Email changes need a separate verification step.</small></div>
      <button class="primary" id="saveProfile" type="submit">Save changes</button><button class="profile-cancel" type="button" onclick="accountPanel()">Cancel</button>
    </form>`);
  $('#profilePhotoFile').addEventListener('change',async event=>{
    const file=event.currentTarget.files[0]; if(!file)return;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024){event.currentTarget.value='';notify('Choose a JPG, PNG, or WebP photo under 8 MB.');return;}
    try { profilePhotoDraft=await compressPhoto(file); $('#profile-preview').innerHTML=`<img src="${esc(profilePhotoDraft)}" alt="Profile photo preview">`; $('#removeProfilePhoto').hidden=false; }
    catch(error){notify(error.message);}
  });
  $('#schoolIdPhotoFile').addEventListener('change',async event=>{
    const file=event.currentTarget.files[0];if(!file)return;
    if(!file.type.startsWith('image/')){event.currentTarget.value='';notify('Choose an image of your school ID.');return;}
    try{schoolIdPhotoDraft=await compressPhoto(file);$('#school-id-preview').innerHTML=`<img src="${esc(schoolIdPhotoDraft)}" alt="School ID photo preview">`;$('#school-id-preview').hidden=false;}
    catch(error){schoolIdPhotoDraft=null;event.currentTarget.value='';notify(error.message);}
  });
  $('#removeProfilePhoto').addEventListener('click',()=>{profilePhotoDraft=null;$('#profilePhotoFile').value='';$('#profile-preview').textContent=currentUser.displayName.slice(0,2).toUpperCase();$('#removeProfilePhoto').hidden=true;});
  $('#profileform').onsubmit=async event=>{
    event.preventDefault();const form=new FormData(event.currentTarget);const button=$('#saveProfile');button.disabled=true;button.textContent='Saving…';
    try { const result=await patch('/api/auth/profile',{displayName:form.get('displayName'),schoolId:form.get('schoolId'),contactNo:form.get('contactNo'),profilePhoto:profilePhotoDraft,idPhoto:schoolIdPhotoDraft});currentUser=result.user;updateNav();accountPanel();notify('Profile updated successfully.'); }
    catch(error){notify(error.message);button.disabled=false;button.textContent='Save changes';}
  };
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
  location.href='http://localhost:3001/';
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
  showModal(`<div class="sell-head">
    <div class="sell-head-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg></div>
    <div class="sell-head-copy"><span class="sell-kicker">SELL ON YOUFIND</span><h2>Create a listing</h2><p>Add clear details and photos to help your item find a new home.</p></div>
    <button class="close" type="button" onclick="closeModal()" aria-label="Close listing form">&#215;</button>
  </div>
  <div class="sell-steps" aria-label="Listing steps"><span class="sell-step-active"><i>1</i> Item details</span><span><i>2</i> Photos</span><span><i>3</i> Publish</span></div>
  <form id="sellform">
    <section class="sell-section" aria-labelledby="sell-details-title">
      <div class="sell-section-head"><span class="sell-section-number">01</span><div><h3 id="sell-details-title">Item details</h3><p>Start with the basics buyers need to know.</p></div></div>
      <div class="sell-form-grid">
        <div class="field sell-field-wide"><label for="itemTitle">Listing title</label><input id="itemTitle" name="title" required maxlength="100" placeholder="e.g. Handmade ceramic bowl"></div>
        <div class="field sell-field-wide"><label>What are you listing?</label><div class="choice sell-type-choice" role="radiogroup" aria-label="Listing type"><label class="selected"><input type="radio" name="kind" value="physical" checked><span class="sell-choice-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m4 8 8-4 8 4v9l-8 4-8-4zM4 8l8 4 8-4M12 12v9M8 6l8 4"/></svg></span><span><strong>Physical item</strong><small>An item you can hand over</small></span></label><label><input type="radio" name="kind" value="digital"><span class="sell-choice-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v5h5M9 13h6m-6 4h6"/></svg></span><span><strong>Digital item</strong><small>A file or digital product</small></span></label></div></div>
        <div class="field"><label for="itemCategory">Category</label><select id="itemCategory" name="category"><option>Home & living</option><option>Art & prints</option><option>Tech</option><option>Gaming</option><option>Photography</option><option>Accessories</option><option>Digital art</option><option>Templates</option><option>Music</option><option>Other</option></select></div>
        <div class="field"><label for="itemPrice">Asking price</label><div class="sell-price-field"><span aria-hidden="true">&#8369;</span><input id="itemPrice" name="price" type="number" min="1" max="1000000" step="0.01" required placeholder="0.00"></div></div>
        <div class="field"><label id="conditionLabel" for="itemCondition">Condition</label><select id="itemCondition" name="condition"><option value="">Choose a condition</option><option>New</option><option>Like new</option><option>Good</option><option>Fair</option><option>For parts or repair</option></select></div>
        <div class="field" id="schoolfield"><label for="itemSchool">School community</label><select id="itemSchool" name="place" required><option value="" disabled selected>Choose a school</option><option>UM Panabo College</option><option>Aces Polytechnic College</option><option>Southern Davao National High School</option></select></div>
        <div class="field sell-field-wide"><label for="itemDescription">Description</label><textarea id="itemDescription" name="description" required maxlength="2000" placeholder="Describe the item's condition, what's included, and any pickup or delivery details."></textarea><small class="sell-field-note">Be specific so members know what to expect.</small></div>
      </div>
    </section>
    <section class="sell-section sell-photo-section" aria-labelledby="sell-photos-title">
      <div class="sell-section-head"><span class="sell-section-number">02</span><div><h3 id="sell-photos-title">Photos</h3><p>Show the item clearly. The first photo will be your cover image.</p></div><span class="sell-optional">Optional &middot; up to 10</span></div>
      <div class="field sell-photo-field"><label for="itemPhoto" class="sell-visually-hidden">Choose item photos</label><div class="photo-upload photo-upload-multiple"><div class="photo-upload-intro"><span class="photo-upload-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="m21 15-5-5L5 21"></path></svg></span><span><strong>Add item photos</strong><small>Choose up to 10 JPG, PNG, or WebP images, up to 8 MB each.</small></span></div><input id="itemPhoto" name="photo" type="file" accept="image/jpeg,image/png,image/webp" multiple class="photo-input"></div><div class="photo-selection-summary"><strong id="photoCount">0 of 10 photos selected</strong><span>Images are optimized before publishing.</span></div><div id="photoPreviewGrid" class="photo-preview-grid" aria-live="polite"></div></div>
    </section>
    <section class="sell-section sell-preference-section" aria-labelledby="sell-preferences-title">
      <div class="sell-section-head"><span class="sell-section-number">03</span><div><h3 id="sell-preferences-title">Selling preferences</h3><p>Choose whether you&rsquo;re open to swapping items.</p></div></div>
      <label class="sell-trade-option"><input type="checkbox" name="trade"><span class="sell-trade-icon" aria-hidden="true">&#8644;</span><span><strong>Open to trade offers</strong><small>Members can propose an item in exchange.</small></span><span class="sell-toggle-indicator" aria-hidden="true"></span></label>
    </section>
    <div class="sell-form-footer"><button type="button" class="sell-cancel" onclick="closeModal()">Cancel</button><span class="sell-footer-note">You can edit your listing later.</span><button type="submit" class="primary sell-submit">Publish listing <span aria-hidden="true">&#8594;</span></button></div>
  </form>`);
  $('#modal').classList.add('sell-modal');
  const schoolField = $('#schoolfield');
  const selectedPhotos=[];
  const photoGrid=$('#photoPreviewGrid');
  const renderPhotoPreviews=()=>{
    $('#photoCount').textContent=`${selectedPhotos.length} of 10 ${selectedPhotos.length===1?'photo':'photos'} selected`;
    photoGrid.innerHTML=selectedPhotos.map((photo,index)=>`<div class="photo-thumb ${index===0?'photo-thumb-cover':''}"><img src="${esc(photo.previewUrl)}" alt="Preview ${index+1}: ${esc(photo.file.name)}"><span class="photo-thumb-label">${index===0?'Cover photo':`Photo ${index+1}`}</span><button type="button" class="photo-thumb-remove" data-remove-photo="${index}" aria-label="Remove ${esc(photo.file.name)}">&#215;</button>${index>0?`<button type="button" class="photo-make-cover" data-cover-photo="${index}">Make cover</button>`:''}</div>`).join('');
  };
  $('#itemPhoto').addEventListener('change',event=>{
    const input=event.currentTarget;const files=[...input.files];input.value='';
    const remaining=10-selectedPhotos.length;
    if(files.length>remaining)notify(remaining?`You can add up to 10 photos. Adding the first ${remaining} available.`:'You already selected 10 photos. Remove one to add another.');
    for(const file of files.slice(0,remaining)){
      if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024){notify(`${file.name}: choose a JPG, PNG, or WebP photo under 8 MB.`);continue;}
      selectedPhotos.push({file,previewUrl:URL.createObjectURL(file)});
    }
    renderPhotoPreviews();
  });
  photoGrid.addEventListener('click',event=>{
    const remove=event.target.closest('[data-remove-photo]');
    if(remove){const index=Number(remove.dataset.removePhoto);const [photo]=selectedPhotos.splice(index,1);if(photo)URL.revokeObjectURL(photo.previewUrl);renderPhotoPreviews();return;}
    const cover=event.target.closest('[data-cover-photo]');
    if(cover){const [photo]=selectedPhotos.splice(Number(cover.dataset.coverPhoto),1);if(photo)selectedPhotos.unshift(photo);renderPhotoPreviews();}
  });
  document.querySelectorAll('#sellform input[name="kind"]').forEach(radio => radio.addEventListener('change', () => {
    document.querySelectorAll('#sellform .choice label').forEach(label => label.classList.toggle('selected',label.querySelector('input').checked));
    const physical = $('#sellform input[name="kind"]:checked').value === 'physical';
    schoolField.hidden = !physical;
    schoolField.querySelector('select').required = physical;
    const conditionLabel = $('#conditionLabel');
    const conditionSelect = $('#itemCondition');
    conditionLabel.textContent = physical ? 'Condition' : 'Delivery';
    conditionSelect.innerHTML = physical
      ? '<option value="">Choose a condition</option><option>New</option><option>Like new</option><option>Good</option><option>Fair</option><option>For parts or repair</option>'
      : '<option value="">Choose a delivery method</option><option>Instant download</option><option>Sent after purchase</option><option>Custom delivery</option>';
  }));
  $('#sellform').onsubmit = async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const kind = form.get('kind');
    const draft = {title:form.get('title'),kind,category:form.get('category'),price:Number(form.get('price')),
      condition:form.get('condition') || (kind==='digital'?'Instant download':'Good'),place:form.get('place'),description:form.get('description'),trade:form.has('trade')};
    const submitButton=event.currentTarget.querySelector('button[type="submit"]');
    try {
      submitButton.disabled=true;
      $('#itemPhoto').disabled=true;photoGrid.querySelectorAll('button').forEach(button=>button.disabled=true);
      if(selectedPhotos.length){draft.photosData=[];for(let index=0;index<selectedPhotos.length;index++){submitButton.textContent=`Processing photo ${index+1} of ${selectedPhotos.length}…`;draft.photosData.push(await compressPhoto(selectedPhotos[index].file));}}
      submitButton.textContent='Publishing listing…';
      const result = await post('/api/listings',draft); listings.unshift(result.listing); closeModal(); active='all'; selectTab('all'); render(); notify('Your listing is live.');
    } catch (error) { notify(error.message);submitButton.disabled=false;submitButton.textContent='Publish listing';$('#itemPhoto').disabled=false;photoGrid.querySelectorAll('button').forEach(button=>button.disabled=false); }
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
    let scale=Math.min(1,1200/Math.max(image.width,image.height));let blob=null;
    for(let attempt=0;attempt<5;attempt++){
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
      blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',[0.82,0.76,0.70,0.64,0.58][attempt]));if(blob&&blob.size<=900*1024)break;scale*=0.82;
    }
    if(image.close)image.close();if(!blob||blob.size>1024*1024)throw new Error('Could not reduce that image below 1 MB. Choose a smaller photo.');return readPhotoData(blob);
  })();
}
function readPhotoData(file) { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read that photo.'));reader.readAsDataURL(file);}); }
function selectTab(kind) {
  active=kind;
  document.querySelectorAll('.tab').forEach(button=>button.classList.toggle('active',button.dataset.kind===kind));
  document.querySelectorAll('.navlinks a').forEach(link=>{
    const linkKind=link.dataset.kind||'all';
    link.classList.toggle('active',linkKind===kind||(linkKind==='all'&&!['physical','digital'].includes(kind)));
  });
}

async function openDetail(id) {
  let item = [...extra,...listings].find(row=>Number(row.id)===Number(id)); if (!item) return;
  const memberItem = Boolean(item.sellerId);
  if(memberItem&&!Array.isArray(item.photosData)){
    try{const result=await request(`/api/listings/${Number(item.id)}`);item={...item,...result.listing};}catch{}
  }
  const photos=Array.isArray(item.photosData)&&item.photosData.length?item.photosData:(item.photoData?[item.photoData]:[]);
  const ownListing = memberItem && isOwnListing(item);
  showModal(`<div class="detail-modal-head">
      <div class="detail-heading-copy"><div class="detail-type"><span>${esc(item.kind)}</span><span class="detail-type-dot" aria-hidden="true">&#183;</span><span>${esc(item.category)}</span></div><h2>${esc(item.title)}</h2></div>
      <button class="close" onclick="closeModal()" aria-label="Close item details">&#215;</button>
    </div>
    <div class="detail-layout">
      <div class="detail-gallery"><div class="detail-visual" style="background:${esc(item.art)}">${photos.length?`<img id="detailMainPhoto" class="item-photo" src="${esc(photos[0])}" alt="Photo 1 of ${esc(item.title)}">`:`<span class="emoji">${esc(item.emoji)}</span><span class="artnote">${esc(item.note)}</span>`}</div>${photos.length>1?`<div class="detail-photo-strip" aria-label="Item photos">${photos.map((photo,index)=>`<button type="button" class="detail-photo-thumb ${index===0?'active':''}" data-photo-index="${index}" aria-label="View photo ${index+1} of ${esc(item.title)}"><img src="${esc(photo)}" alt=""><span>${index+1}</span></button>`).join('')}</div>`:''}</div>
      <div class="detail-pane">
        <div class="detail-seller"><span class="detail-seller-avatar">${esc(item.initial)}</span><span class="detail-seller-copy"><strong>${esc(item.seller)} ${item.verified?'<span class="detail-verified" aria-label="Verified member">&#10003;</span>':''}</strong><small>${memberItem?'Goodfind member':'Community listing'}</small></span></div>
        <div class="detail-priceblock"><div><span class="detail-label">Asking price</span><strong class="detailprice">${price(item.price)}</strong></div>${item.trade?'<span class="detail-trade-pill">Trade considered</span>':''}</div>
        <div class="detail-facts"><div class="detail-fact"><span>Condition</span><strong>${esc(item.condition)}</strong></div><div class="detail-fact"><span>Category</span><strong>${esc(item.category)}</strong></div><div class="detail-fact detail-fact-place"><span>${item.kind==='digital'?'Delivery':'Pickup location'}</span><strong><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"></path><circle cx="12" cy="10" r="2.5"></circle></svg>${esc(item.place)}</strong></div></div>
        <section class="detail-description"><h3>About this item</h3><p>${esc(item.description)}</p></section>
      </div>
    </div>
    ${ownListing?'<div class="detail-owner-note"><strong>Your listing</strong><span>Buyer messages about this item are in your inbox.</span></div>':''}
    <div class="detail-actions">${memberItem?(ownListing?'<button class="primary" onclick="openMessages()">View buyer messages</button>':'<button class="primary" onclick="startCheckout('+Number(item.id)+')">Buy this item</button><button class="filterbtn" onclick="openConversation('+Number(item.id)+')">Message seller</button>'):'<button class="primary" disabled title="Member checkout is available for member listings">Member checkout unavailable</button>'}${item.trade&&!ownListing?`<button class="filterbtn detail-trade-button" onclick="openTrade(${Number(item.id)})">&#8596; Make a trade offer</button>`:''}</div>`);
  $('#modal').classList.add('detail-modal');
  document.querySelectorAll('.detail-photo-thumb').forEach(button=>button.addEventListener('click',()=>{
    const index=Number(button.dataset.photoIndex);const image=$('#detailMainPhoto');if(!image||!photos[index])return;
    image.src=photos[index];image.alt=`Photo ${index+1} of ${item.title}`;
    document.querySelectorAll('.detail-photo-thumb').forEach(thumb=>thumb.classList.toggle('active',thumb===button));
  }));
}
async function startCheckout(listingId) {
  if (!currentUser) { closeModal(); openAccount(); notify('Sign in before checkout.'); return; }
  try { const result = await post('/api/payments/checkout',{listingId}); location.href=result.url; }
  catch (error) { notify(error.message); }
}

async function openTrade(listingId) {
  const target = [...extra,...listings].find(item=>Number(item.id)===Number(listingId)); if (!target) return;
  if (!currentUser) { closeModal(); openAccount(); notify('Sign in to make a trade offer.'); return; }
  if (isOwnListing(target)) { closeModal(); notify('You can’t make a trade offer on your own listing.'); return; }
  const ownListings = listings.filter(item=>isOwnListing(item) && item.trade && item.status==='active' && Number(item.id)!==Number(target.id));
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
    updateMessagesBadge(conversations);
    showChat(`<div class="modalhead"><div><h2>Messages</h2><p>Private conversations about member listings.</p></div><button class="close" onclick="closeModal()">×</button></div>
      ${conversations.length?conversations.map(thread=>`<button class="filterbtn" style="width:100%;height:auto;text-align:left;padding:13px;margin:5px 0;display:flex;align-items:center;gap:12px" onclick="openConversation(${thread.listingId},${thread.otherId})"><span style="font-size:23px">${esc(thread.emoji)}</span><span><strong>${esc(thread.title)}</strong><small style="display:block;color:#839087;margin-top:3px">${esc(thread.otherName)}</small></span></button>`).join(''):'<div class="empty" style="padding:35px 10px"><strong>No messages yet</strong>Open a member listing to message its seller.</div>'}`);
    const inboxList=document.createElement('div');
    inboxList.className='message-inbox-list';
    while ($('#modal').children.length > 1) inboxList.append($('#modal').children[1]);
    $('#modal').append(inboxList);
  } catch (error) { notify(error.message); }
}
async function openConversation(listingId, otherId) {
  if (!currentUser) {
    try { sessionStorage.setItem('goodfind_pending_conversation',JSON.stringify({listingId:Number(listingId),otherId:otherId==null?null:Number(otherId)})); } catch {}
    openAccount(); notify('Sign in first. Your conversation will open when you return.'); return;
  }
  const item = [...extra,...listings].find(row=>Number(row.id)===Number(listingId)); if (!item) return;
  if (!item.sellerId) { notify('Sample listings are view-only.'); return; }
  try {
    const isSeller=Number(currentUser.id)===Number(item.sellerId);
    if (isSeller&&!otherId) { notify('Open a buyer thread from your Messages list.'); return; }
    const recipientId=isSeller?Number(otherId):Number(item.sellerId);
    const query=isSeller?`?with=${recipientId}`:'';
    const {messages} = await request(`/api/listings/${listingId}/messages${query}`);
    markConversationRead(listingId,recipientId,messages);
    showChat(`<div class="modalhead"><div><h2>Message about ${esc(item.title)}</h2><p>Private conversation between members.</p></div><button class="close" onclick="closeModal()">×</button></div>
      <div id="message-list" style="max-height:300px;overflow:auto;background:#f6f8f4;border-radius:12px;padding:12px">${messages.length?messages.map(message=>`<div style="max-width:85%;margin:8px 0 8px ${message.mine?'auto':'0'};padding:10px 12px;border-radius:12px;background:${message.mine?'#e5f2e9':'white'};font-size:12px;line-height:1.5"><small style="display:block;color:#88948b;margin-bottom:4px">${message.mine?'You':esc(message.sender)}</small>${esc(message.body)}</div>`).join(''):'<p style="text-align:center;color:#89938c;font-size:12px">Start the conversation with a message.</p>'}</div>
      <form id="messageform" style="display:flex;gap:8px;margin-top:12px"><input name="body" required maxlength="2000" placeholder="Write a message..." style="flex:1;min-width:0;border:1px solid var(--line);border-radius:10px;padding:11px"><button class="primary" type="submit">Send</button></form><button class="sort" onclick="openConversation(${listingId},${recipientId})">Refresh messages</button>`);
    $('#messageform').onsubmit = async event => {
      event.preventDefault(); const form=event.currentTarget; const content=new FormData(form).get('body'); const sendButton=form.querySelector('button[type="submit"]');
      sendButton.disabled=true;
      try { await post(`/api/listings/${listingId}/messages`,{body:content,recipientId}); await openConversation(listingId,recipientId); }
      catch(error) { notify(error.message); }
      finally { if(sendButton.isConnected) sendButton.disabled=false; }
    };
    $('#message-list').scrollTop=$('#message-list').scrollHeight; $('#messageform input').focus();
  } catch (error) { notify(error.message); }
}

function toggleFilters() { const panel=$('#filterpanel'); panel.style.display=panel.style.display==='flex'?'none':'flex'; }
$('#tabs').addEventListener('click',event=>{const button=event.target.closest('.tab');if(!button)return;selectTab(button.dataset.kind);render();});
document.querySelectorAll('.navlinks [data-kind]').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();document.querySelector(`#tabs [data-kind="${link.dataset.kind}"]`).click();$('#discover').scrollIntoView({behavior:'smooth'});}));
document.querySelector('.navlinks a[href="#discover"]:not([data-kind])').addEventListener('click',event=>{event.preventDefault();selectTab('all');render();$('#discover').scrollIntoView({behavior:'smooth'});});
$('#search').addEventListener('input',render); $('#tradeonly').addEventListener('change',render); $('#locationfilter').addEventListener('change',render); $('#sortby').addEventListener('change',render);
document.addEventListener('keydown',event=>{if(event.key==='/'&&document.activeElement.tagName!=='INPUT'){event.preventDefault();$('#search').focus();}if(event.key==='Escape')closeModal();});

async function boot() {
  try {
    await request('/api/health'); apiOnline=true;
    const [account,market] = await Promise.all([request('/api/auth/me'),request('/api/listings')]);
    currentUser=account.user; setListings(market.listings); updateNav(); render(); await refreshMessagesBadge();
  } catch { apiOnline=false; updateNav(); }
  if (currentUser) {
    const pending=sessionStorage.getItem('goodfind_pending_conversation');
    if (pending) {
      sessionStorage.removeItem('goodfind_pending_conversation');
      try { const conversation=JSON.parse(pending); if(Number.isInteger(Number(conversation.listingId))) await openConversation(Number(conversation.listingId),conversation.otherId==null?null:Number(conversation.otherId)); }
      catch { notify('Could not reopen that conversation. Open the listing and try again.'); }
    }
  }
  const params=new URLSearchParams(location.search);
  if (params.get('payment')==='success') notify('Payment submitted. The order updates after Stripe confirms it.');
  if (params.get('payment')==='cancel') {
    if (currentUser&&params.get('order_id')) { try { await post('/api/payments/cancel',{orderId:params.get('order_id')}); } catch {} }
    notify('Checkout was canceled. The listing is available again.');
  }
  if (params.get('payout_setup')==='return'&&currentUser) {
    try { await request('/api/payments/connect/status'); const account=await request('/api/auth/me');currentUser=account.user;updateNav();notify(currentUser.payoutsConnected?'Payout setup is complete.':'Stripe may need more information before payouts are enabled.'); } catch(error) { notify(error.message); }
  }
  if (params.get('sell')==='1') openSell();
}

render();
boot();
setInterval(()=>{if(currentUser)refreshMessagesBadge();},15000);
