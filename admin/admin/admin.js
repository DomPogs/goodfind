'use strict';

const listings = [
  { title:'Vintage film camera', emoji:'📷', seller:'Jamie Cruz', school:'UM Panabo College', price:145, status:'Active' },
  { title:'Canvas tote bag', emoji:'👜', seller:'Alex Santos', school:'UM Panabo College', price:24, status:'Active' },
  { title:'Wireless headphones', emoji:'🎧', seller:'Mika Reyes', school:'Aces Polytechnic College', price:58, status:'Review' },
  { title:'Handmade desk lamp', emoji:'💡', seller:'Paolo Dizon', school:'Southern Davao National High School', price:32, status:'Active' },
  { title:'Digital art pack', emoji:'🎨', seller:'Rina Flores', school:'Aces Polytechnic College', price:12, status:'Hidden' },
  { title:'Novel collection', emoji:'📚', seller:'Bea Garcia', school:'Southern Davao National High School', price:18, status:'Active' },
  { title:'Mechanical keyboard', emoji:'⌨️', seller:'Noah Lim', school:'UM Panabo College', price:75, status:'Review' },
  { title:'Ceramic coffee mug', emoji:'☕', seller:'Ella Tan', school:'Aces Polytechnic College', price:16, status:'Active' }
];
const members = [
  { name:'Jamie Cruz', school:'UM Panabo College', initial:'J', joined:'Joined today' },
  { name:'Mika Reyes', school:'Aces Polytechnic College', initial:'M', joined:'Joined yesterday' },
  { name:'Paolo Dizon', school:'Southern Davao National High School', initial:'P', joined:'Joined 2 days ago' }
];
const rows = document.querySelector('#listingRows');
const query = document.querySelector('#listingSearch');
const toast = document.querySelector('#adminToast');
let expanded = false;

function renderListings(){
  const term=query.value.trim().toLowerCase();
  const matches=listings.map((item,index)=>({...item,index})).filter(item=>[item.title,item.seller,item.school,item.status].join(' ').toLowerCase().includes(term));
  const visible=expanded?matches:matches.slice(0,5);
  rows.innerHTML=visible.map(item=>`<tr>
    <td><div class="item-cell"><span class="item-emoji">${item.emoji}</span>${item.title}</div></td>
    <td>${item.seller}</td><td class="school-cell">${item.school}</td><td class="price-cell">$${item.price.toFixed(2)}</td>
    <td><span class="status-pill status-${item.status.toLowerCase()}">${item.status}</span></td>
    <td><button class="row-action" type="button" data-index="${item.index}">${item.status==='Hidden'?'Restore':'Hide'}</button></td>
  </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;padding:25px;color:#89948c">No matching listings.</td></tr>';
  document.querySelector('#sidebarListingCount').textContent=listings.filter(item=>item.status!=='Hidden').length;
  document.querySelector('#showingCount').textContent=`Showing ${visible.length} of ${matches.length} preview listings`;
  document.querySelector('#showMore').innerHTML=expanded?'Show fewer <span>↑</span>':'View all listings <span>→</span>';
}
function renderMembers(){
  document.querySelector('#memberRows').innerHTML=members.map(member=>`<div class="member-row"><span class="member-avatar">${member.initial}</span><span class="member-meta"><strong>${member.name}</strong><small>${member.school}</small></span><span class="member-tag">${member.joined}</span></div>`).join('');
}
function showToast(message){toast.textContent=message;toast.classList.add('show');clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>toast.classList.remove('show'),2200);}

query.addEventListener('input',renderListings);
rows.addEventListener('click',event=>{
  const button=event.target.closest('[data-index]');if(!button)return;
  const item=listings[Number(button.dataset.index)];
  item.status=item.status==='Hidden'?'Active':'Hidden';
  renderListings();showToast(`Preview only: ${item.title} marked ${item.status.toLowerCase()}.`);
});
document.querySelector('#showMore').addEventListener('click',()=>{expanded=!expanded;renderListings();});
document.querySelectorAll('.sidebar-link').forEach(link=>link.addEventListener('click',()=>{
  document.querySelectorAll('.sidebar-link').forEach(item=>item.classList.toggle('active',item===link));
}));
renderListings();renderMembers();
