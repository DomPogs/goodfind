'use strict';

const pageBasePath = new URL('.', location.href).pathname.replace(/\/$/, '');
const ordersRoot = document.querySelector('#orders-content');
const ordersToast = document.querySelector('#orders-toast');
const ordersNotice = document.querySelector('#orders-notice');
let ordersData = null;
let activeOrdersTab = new URLSearchParams(location.search).get('tab');
let toastTimer = null;

const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const peso = value => `₱${Number(value || 0).toLocaleString('en-PH', {minimumFractionDigits:2, maximumFractionDigits:2})}`;

async function api(path, options = {}) {
  const response = await fetch(`${pageBasePath}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {})}
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

const send = (path, body) => api(path, {method:'POST', body:JSON.stringify(body)});
const update = (path, body) => api(path, {method:'PATCH', body:JSON.stringify(body)});

function showToast(message) {
  ordersToast.textContent = message;
  ordersToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ordersToast.classList.remove('show'), 2800);
}

function orderDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString('en-PH', {dateStyle:'medium', timeStyle:'short'});
}

function orderStateLabel(order) {
  if (order.queueStatus === 'queued') return order.myRole === 'seller' ? (order.queuePosition === 1 ? 'Needs your review' : 'In the queue') : 'Waiting for seller';
  return ({approved:'Approved', completed:'Exchange complete', cancelled:'Closed'})[order.queueStatus] || order.queueStatus;
}

function orderProgressMarkup(order) {
  if (order.queueStatus === 'cancelled') return '';
  const step = order.queueStatus === 'queued' ? 1 : order.queueStatus === 'approved' ? 2 : 3;
  return `<div class="order-progress" aria-label="Step ${step} of 3: ${html(orderStateLabel(order))}"><span class="${step >= 1 ? 'reached' : ''} ${step >= 2 ? 'connected' : ''}"><i>1</i> Request</span><span class="${step >= 2 ? 'reached' : ''} ${step >= 3 ? 'connected' : ''}"><i>2</i> Approval</span><span class="${step >= 3 ? 'reached' : ''}"><i>3</i> Exchange</span></div>`;
}

function renderOrder(order) {
  const isSeller = order.myRole === 'seller';
  let guidance = '';
  let actions = '';
  if (isSeller && order.queueStatus === 'queued') {
    guidance = order.queuePosition === 1 ? 'This is the next request. Approval reserves the item and closes the remaining requests.' : `Request ${order.queuePosition} in line. Review earlier requests first, or decline this one.`;
    actions = `${order.queuePosition === 1 ? `<button class="primary" type="button" data-order-action="approved" data-order-id="${order.id}">Approve &amp; reserve item</button>` : ''}<button class="filterbtn" type="button" data-order-action="cancelled" data-order-id="${order.id}">Decline request</button>`;
  } else if (!isSeller && order.queueStatus === 'queued') {
    guidance = `You’re ${order.queuePosition === 1 ? 'next' : `#${order.queuePosition}`} in line. The seller reviews requests in the order they arrive.`;
    actions = `<button class="filterbtn" type="button" data-order-action="cancelled" data-order-id="${order.id}">Cancel request</button>`;
  } else if (isSeller && order.queueStatus === 'approved') {
    guidance = order.hasPaymentSession ? 'Payment is being processed. The item will be marked sold when payment is confirmed.' : 'Arrange the handoff with the buyer. After they receive the item, confirm the exchange to mark it sold.';
    actions = order.hasPaymentSession ? '' : `<button class="primary" type="button" data-order-action="completed" data-order-id="${order.id}">Confirm handoff &amp; mark sold</button><button class="filterbtn" type="button" data-order-action="cancelled" data-order-id="${order.id}">Cancel order</button>`;
  } else if (!isSeller && order.queueStatus === 'approved') {
    guidance = order.hasPaymentSession ? 'Payment is being processed. This order will update after Stripe confirms it.' : 'The seller approved your request. Arrange pickup or delivery with them, then the seller can confirm the handoff.';
    actions = `${order.paymentReady && !order.hasPaymentSession ? `<button class="primary" type="button" data-order-action="pay" data-order-id="${order.id}">Pay securely</button>` : ''}<button class="filterbtn" type="button" data-order-message="${order.listingId}">Message seller</button>`;
  } else if (order.queueStatus === 'completed') {
    actions = order.hasReviewed
      ? '<span class="order-review-thanks">Review submitted. Thanks for sharing your experience.</span>'
      : `<div class="order-review-prompt">How did the handoff go? Your review helps other members.</div><form class="order-review-form" data-review-order="${order.id}"><label>Rate ${html(order.otherName)}<select name="rating" required><option value="5">★★★★★ · Excellent</option><option value="4">★★★★☆ · Good</option><option value="3">★★★☆☆ · Okay</option><option value="2">★★☆☆☆ · Poor</option><option value="1">★☆☆☆☆ · Very poor</option></select></label><label class="order-review-comment">Add a note (optional)<textarea name="remarks" maxlength="2000" placeholder="How did the exchange go?"></textarea></label><button class="primary" type="submit">Submit review</button></form>`;
  }
  const reviews = (order.reviews || []).map(review => `<div class="order-review-read"><strong>${html(review.reviewerName)} · ${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</strong>${review.remarks ? `<p>${html(review.remarks)}</p>` : ''}</div>`).join('');
  return `<article class="order-card"><div class="order-card-main"><div class="order-item-thumb">${order.itemPhoto ? `<img src="${html(order.itemPhoto)}" alt="">` : `<span>${html(order.itemEmoji || '◇')}</span>`}</div><div class="order-card-copy"><div class="order-card-meta"><span>Order #${order.id} · ${isSeller ? 'Buyer' : 'Seller'}: ${html(order.otherName)}</span><span class="order-state order-state-${html(order.queueStatus)}">${html(orderStateLabel(order))}</span></div><h4>${html(order.itemTitle)}</h4><p>${peso(order.amount)}</p><small>${html(orderDate(order.date))}</small></div></div>${orderProgressMarkup(order)}${guidance ? `<div class="order-guidance">${html(guidance)}</div>` : ''}${actions ? `<div class="order-card-actions">${actions}</div>` : ''}${reviews ? `<div class="order-review-list">${reviews}</div>` : ''}</article>`;
}

function renderListing(listing) {
  const labels = {active:'Available', reserved:'Reserved', sold:'Sold', hidden:'Hidden by admin', traded:'Traded'};
  let controls = '';
  if (listing.status === 'active') controls = `<button type="button" class="filterbtn" data-listing-status="reserved" data-listing-id="${listing.id}">Mark reserved</button><button type="button" class="filterbtn" data-listing-status="sold" data-listing-id="${listing.id}">Mark sold offline</button>`;
  else if (listing.status === 'reserved' && listing.approvedCount > 0) controls = '<span class="order-wait-note">Reserved for an approved order.</span>';
  else if (listing.status === 'reserved') controls = `<button type="button" class="filterbtn" data-listing-status="available" data-listing-id="${listing.id}">Make available</button><button type="button" class="filterbtn" data-listing-status="sold" data-listing-id="${listing.id}">Mark sold offline</button>`;
  else if (listing.status === 'sold') controls = `<button type="button" class="filterbtn" data-listing-status="available" data-listing-id="${listing.id}">Relist item</button>`;
  return `<article class="managed-listing"><div><strong>${html(listing.title)}</strong><small>${peso(listing.price)} · ${listing.queuedCount} waiting request${listing.queuedCount === 1 ? '' : 's'}</small></div><span class="order-state order-state-${html(listing.status)}">${html(labels[listing.status] || listing.status)}</span><div class="managed-listing-actions">${controls}</div></article>`;
}

function defaultTab(data) {
  if (data.orders.some(order => order.myRole === 'seller' && order.queueStatus === 'queued')) return 'selling';
  if (data.orders.some(order => order.myRole === 'buyer' && ['queued','approved'].includes(order.queueStatus))) return 'buying';
  if (data.orders.some(order => order.myRole === 'seller')) return 'selling';
  if (data.orders.some(order => order.myRole === 'buyer')) return 'buying';
  return 'listings';
}

function render() {
  const data = ordersData;
  const buying = data.orders.filter(order => order.myRole === 'buyer');
  const selling = data.orders.filter(order => order.myRole === 'seller');
  const waiting = data.orders.filter(order => order.queueStatus === 'queued').length;
  const inProgress = data.orders.filter(order => order.queueStatus === 'approved').length;
  const completed = data.orders.filter(order => order.queueStatus === 'completed').length;
  let section;
  if (activeOrdersTab === 'selling') {
    section = `<div class="orders-section-heading"><div><h2>Requests from buyers</h2><small>Approve the next request to reserve the item.</small></div><span>${selling.length}</span></div>${selling.length ? `<div class="order-stack">${selling.map(renderOrder).join('')}</div>` : '<div class="orders-empty"><strong>No buyer requests yet</strong><small>Requests for your items will show up here.</small></div>'}`;
  } else if (activeOrdersTab === 'listings') {
    section = `<div class="orders-section-heading"><div><h2>Your listed items</h2><small>Update availability or review buyer requests.</small></div><span>${data.myListings.length}</span></div>${data.myListings.length ? `<div class="managed-listings">${data.myListings.map(renderListing).join('')}</div>` : '<div class="orders-empty"><strong>No items listed yet</strong><small>Publish an item and manage it here.</small></div>'}<p class="orders-footnote">Marking an item sold offline closes its open requests. Complete an approved order after the handoff so both people can leave a review.</p>`;
  } else {
    section = `<div class="orders-section-heading"><div><h2>Your purchase requests</h2><small>Follow each request until the exchange is complete.</small></div><span>${buying.length}</span></div>${buying.length ? `<div class="order-stack">${buying.map(renderOrder).join('')}</div>` : '<div class="orders-empty"><strong>No purchase requests yet</strong><small>When you request an item, its progress will show up here.</small></div>'}`;
  }
  ordersRoot.innerHTML = `<div class="orders-summary"><div><strong>${waiting}</strong><span>Waiting</span></div><div><strong>${inProgress}</strong><span>In progress</span></div><div><strong>${completed}</strong><span>Completed</span></div></div><div class="orders-how"><strong>How it works</strong><span><b>1</b> Buyer requests</span><span><b>2</b> Seller approves</span><span><b>3</b> Confirm handoff</span></div><nav class="orders-tabs" aria-label="Order sections"><button type="button" class="orders-tab ${activeOrdersTab === 'buying' ? 'active' : ''}" data-orders-tab="buying">Buying <b>${buying.length}</b></button><button type="button" class="orders-tab ${activeOrdersTab === 'selling' ? 'active' : ''}" data-orders-tab="selling">Selling <b>${selling.length}</b></button><button type="button" class="orders-tab ${activeOrdersTab === 'listings' ? 'active' : ''}" data-orders-tab="listings">My items <b>${data.myListings.length}</b></button></nav><section class="orders-section orders-tab-panel">${section}</section>`;
  ordersRoot.classList.remove('is-loading');
}

async function loadOrders() {
  const {orders, myListings} = await api('/api/orders');
  ordersData = {orders:orders || [], myListings:myListings || []};
  if (!['buying','selling','listings'].includes(activeOrdersTab)) activeOrdersTab = defaultTab(ordersData);
  render();
}

function showError(error) {
  ordersRoot.innerHTML = `<div class="orders-page-error"><span aria-hidden="true">!</span><h2>Orders could not be loaded</h2><p>${html(error.message || 'Please try again in a moment.')}</p><button class="primary" type="button" id="orders-retry">Try again</button></div>`;
  document.querySelector('#orders-retry').addEventListener('click', () => { ordersRoot.innerHTML = '<div class="orders-page-loading"><span class="orders-loading-mark" aria-hidden="true">↻</span><strong>Loading your orders</strong><small>Your requests and listings will be ready in a moment.</small></div>'; loadOrders().catch(showError); });
}

function signInRedirect() {
  const returnTo = `${location.pathname}${location.search}`;
  location.href = `${pageBasePath}/auth/?mode=login&returnTo=${encodeURIComponent(returnTo)}`;
}

ordersRoot.addEventListener('click', async event => {
  const tabButton = event.target.closest('[data-orders-tab]');
  if (tabButton && ordersData) {
    activeOrdersTab = tabButton.dataset.ordersTab;
    const url = new URL(location.href);
    url.searchParams.set('tab', activeOrdersTab);
    history.replaceState(null, '', url);
    render();
    return;
  }
  const messageButton = event.target.closest('[data-order-message]');
  if (messageButton) {
    location.href = `${pageBasePath}/marketplace.html?openMessage=${encodeURIComponent(messageButton.dataset.orderMessage)}`;
    return;
  }
  const orderButton = event.target.closest('[data-order-action]');
  if (orderButton) {
    const action = orderButton.dataset.orderAction;
    orderButton.disabled = true;
    orderButton.classList.add('is-loading');
    orderButton.setAttribute('aria-busy','true');
    try {
      if (action === 'pay') {
        const result = await send('/api/payments/checkout', {orderId:Number(orderButton.dataset.orderId)});
        location.href = result.url;
        return;
      }
      await update(`/api/orders/${Number(orderButton.dataset.orderId)}`, {action});
      showToast(action === 'approved' ? 'Order approved. The item is now reserved.' : action === 'completed' ? 'Exchange completed. The item is marked sold.' : 'Order updated.');
      await loadOrders();
    } catch (error) { showToast(error.message); orderButton.disabled = false; orderButton.classList.remove('is-loading'); orderButton.removeAttribute('aria-busy'); }
    return;
  }
  const listingButton = event.target.closest('[data-listing-status]');
  if (listingButton) {
    listingButton.disabled = true;
    listingButton.classList.add('is-loading');
    listingButton.setAttribute('aria-busy','true');
    try {
      await update(`/api/listings/${Number(listingButton.dataset.listingId)}/status`, {status:listingButton.dataset.listingStatus});
      showToast('Listing status updated.');
      await loadOrders();
    } catch (error) { showToast(error.message); listingButton.disabled = false; listingButton.classList.remove('is-loading'); listingButton.removeAttribute('aria-busy'); }
  }
});

ordersRoot.addEventListener('submit', async event => {
  const form = event.target.closest('.order-review-form');
  if (!form) return;
  event.preventDefault();
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  submitButton.classList.add('is-loading');
  submitButton.setAttribute('aria-busy','true');
  try {
    const values = new FormData(form);
    await send(`/api/orders/${Number(form.dataset.reviewOrder)}/reviews`, {rating:Number(values.get('rating')), remarks:values.get('remarks')});
    showToast('Your review was submitted.');
    await loadOrders();
  } catch (error) { showToast(error.message); submitButton.disabled = false; submitButton.classList.remove('is-loading'); submitButton.removeAttribute('aria-busy'); }
});

async function bootOrders() {
  try {
    const {user} = await api('/api/auth/me');
    if (!user) { signInRedirect(); return; }
    await loadOrders();
  } catch (error) {
    if (/sign in|unauthorized|authentication/i.test(error.message)) { signInRedirect(); return; }
    showError(error);
  }
}

const params = new URLSearchParams(location.search);
if (params.get('created') === '1') ordersNotice.textContent = 'Your purchase request was added to the seller’s queue.';
if (params.get('created') === '1') ordersNotice.hidden = false;
bootOrders();
