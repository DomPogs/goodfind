'use strict';

const profileBasePath = new URL('.', location.href).pathname.replace(/\/$/, '');
const identityHost = document.querySelector('#profile-identity');
const listingHost = document.querySelector('#profile-listings-grid');
const filtersHost = document.querySelector('#profile-listing-filters');
let profileUser = null;
let profileListings = [];
let activeFilter = 'all';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const formatPrice = value => `₱${Number(value || 0).toLocaleString('en-PH', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
const statusNames = {active:'Available', pending:'Awaiting admin review', rejected:'Rejected by admin', reserved:'Reserved', sold:'Sold', hidden:'Hidden', traded:'Traded'};

async function getJson(path) {
  const response = await fetch(`${profileBasePath}${path}`, {credentials:'same-origin'});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function signIn() {
  const returnTo = `${location.pathname}${location.search}`;
  location.href = `${profileBasePath}/auth/?mode=login&returnTo=${encodeURIComponent(returnTo)}`;
}

function formatMemberSince(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Goodfind member' : `Member since ${date.toLocaleDateString('en-PH', {month:'long', year:'numeric'})}`;
}

function renderIdentity(user) {
  const avatar = user.profilePhoto
    ? `<img src="${escapeHtml(user.profilePhoto)}" alt="${escapeHtml(user.displayName)}’s profile photo">`
    : `<span>${escapeHtml(user.displayName.slice(0,2).toUpperCase())}</span>`;
  const verification = user.idVerificationStatus || 'unsubmitted';
  const verificationNames = {verified:'School ID verified', pending:'ID review pending', rejected:'ID needs resubmission', unsubmitted:'ID not submitted'};
  identityHost.innerHTML = `<div class="profile-identity-avatar">${avatar}</div><div class="profile-identity-copy"><div class="eyebrow">GOODFIND MEMBER</div><h2>${escapeHtml(user.displayName)}</h2><p>${escapeHtml(user.schoolId || 'School community member')} <span aria-hidden="true">·</span> ${escapeHtml(formatMemberSince(user.createdAt))}</p><span class="profile-verification-pill ${escapeHtml(verification)}"><i aria-hidden="true"></i>${escapeHtml(verificationNames[verification] || verificationNames.unsubmitted)}</span></div><div class="profile-identity-actions"><a class="filterbtn" href="marketplace.html?account=1">Account settings</a><a class="filterbtn" href="orders.html?tab=listings">Manage listings</a></div>`;
}

function filteredListings() {
  return activeFilter === 'all' ? profileListings : profileListings.filter(item => item.status === activeFilter);
}

function listingCard(item) {
  const thumb = item.photoData
    ? `<img src="${escapeHtml(item.photoData)}" alt="${escapeHtml(item.title)}">`
    : `<span>${escapeHtml(item.emoji || '◇')}</span>`;
  const date = new Date(item.createdAt);
  const listed = Number.isNaN(date.getTime()) ? '' : `Listed ${date.toLocaleDateString('en-PH', {month:'short', day:'numeric', year:'numeric'})}`;
  return `<article class="profile-all-listing-card"><div class="profile-all-listing-image" style="background:${escapeHtml(item.art || 'var(--canvas)')}">${thumb}</div><div class="profile-all-listing-copy"><div class="profile-all-listing-top"><span>${escapeHtml(item.category || 'Other')}</span><span class="order-state order-state-${escapeHtml(item.status)}">${escapeHtml(statusNames[item.status] || item.status)}</span></div><h3>${escapeHtml(item.title)}</h3><strong class="profile-all-listing-price">${formatPrice(item.price)}</strong><small>${escapeHtml(listed)}</small><a href="orders.html?tab=listings">Manage listing <span aria-hidden="true">→</span></a></div></article>`;
}

function renderListings() {
  const counts = {all:profileListings.length};
  for (const item of profileListings) counts[item.status] = (counts[item.status] || 0) + 1;
  const filters = [
    ['all','All items'], ['pending','Awaiting review'], ['active','Available'], ['reserved','Reserved'], ['sold','Sold'], ['hidden','Hidden'], ['rejected','Rejected'], ['traded','Traded']
  ].filter(([key]) => key === 'all' || counts[key]);
  filtersHost.hidden = profileListings.length === 0;
  filtersHost.innerHTML = filters.map(([key,label]) => `<button type="button" class="profile-listing-filter ${activeFilter === key ? 'active' : ''}" data-profile-filter="${key}" aria-pressed="${activeFilter === key}">${label}<span>${counts[key] || 0}</span></button>`).join('');
  const items = filteredListings();
  if (!profileListings.length) {
    listingHost.innerHTML = `<div class="profile-all-empty"><span aria-hidden="true">◇</span><h2>No listings yet</h2><p>Items you post will appear here so you can review their availability.</p><a class="primary" href="marketplace.html?sell=1">List your first item</a></div>`;
    return;
  }
  if (!items.length) {
    listingHost.innerHTML = `<div class="profile-all-empty profile-filter-empty"><h2>No ${escapeHtml(statusNames[activeFilter] || 'matching')} items</h2><p>Choose another filter to see more of your listings.</p><button class="filterbtn" type="button" data-profile-filter="all">Show all items</button></div>`;
    return;
  }
  listingHost.innerHTML = items.map(listingCard).join('');
}

filtersHost.addEventListener('click', event => {
  const button = event.target.closest('[data-profile-filter]');
  if (!button) return;
  activeFilter = button.dataset.profileFilter;
  renderListings();
});
listingHost.addEventListener('click', event => {
  const button = event.target.closest('[data-profile-filter]');
  if (!button) return;
  activeFilter = button.dataset.profileFilter;
  renderListings();
});

async function bootProfile() {
  try {
    const {user} = await getJson('/api/auth/me');
    if (!user) { signIn(); return; }
    profileUser = user;
    renderIdentity(profileUser);
    const {listings} = await getJson('/api/auth/listings?all=1');
    profileListings = listings || [];
    renderListings();
  } catch (error) {
    if (/sign in|unauthorized|authentication/i.test(error.message)) { signIn(); return; }
    identityHost.innerHTML = `<div class="profile-page-error"><h2>Profile could not be loaded</h2><p>${escapeHtml(error.message)}</p><button type="button" class="filterbtn" onclick="location.reload()">Try again</button></div>`;
    listingHost.innerHTML = '';
  }
}

bootProfile();
