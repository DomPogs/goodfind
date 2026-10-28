'use strict';

const accountLink=document.querySelector('#landingAccountLink');
const adminLink=document.querySelector('#landingAdminLink');
let sessionCheckRunning=false;

async function syncLandingSession(){
  if(sessionCheckRunning||document.visibilityState==='hidden')return;
  sessionCheckRunning=true;
  try{
    const response=await fetch(new URL('api/auth/me',location.href),{credentials:'same-origin',cache:'no-store'});
    if(!response.ok)return;
    const {user}=await response.json();
    if(!user){
      accountLink.textContent='Sign in';
      accountLink.href='auth/?mode=login';
      accountLink.removeAttribute('title');
      accountLink.removeAttribute('aria-label');
      if(adminLink)adminLink.textContent='Admin login';
      return;
    }
    accountLink.textContent='My account';
    accountLink.href='marketplace.html#discover';
    accountLink.title=`Signed in as ${user.displayName||user.email}`;
    accountLink.setAttribute('aria-label',`My account, signed in as ${user.displayName||user.email}`);
    if(adminLink)adminLink.textContent=user.role==='admin'?'Admin panel':'Admin login';
  }catch{}
  finally{sessionCheckRunning=false;}
}

syncLandingSession();
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncLandingSession();});
