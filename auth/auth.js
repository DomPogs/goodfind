'use strict';

const loginTab=document.querySelector('#loginTab');
const signupTab=document.querySelector('#signupTab');
const nameField=document.querySelector('#nameField');
const signupFields=['#schoolField','#contactField'].map(selector=>document.querySelector(selector));
const password=document.querySelector('#password');
const email=document.querySelector('#email');
const title=document.querySelector('#formTitle');
const intro=document.querySelector('#formIntro');
const submit=document.querySelector('#submitButton');
const notice=document.querySelector('#authnotice');
const authForm=document.querySelector('#authForm');
const appBasePath=new URL('../',location.href).pathname.replace(/\/$/,'');

function setMode(mode){
  const signup=mode==='signup';
  const modeChanged=signup!==signupTab.classList.contains('active');
  if(modeChanged)authForm.reset();
  authForm.autocomplete=signup?'off':'on';
  email.autocomplete=signup?'off':'username';
  loginTab.classList.toggle('active',!signup); loginTab.setAttribute('aria-selected',String(!signup));
  signupTab.classList.toggle('active',signup); signupTab.setAttribute('aria-selected',String(signup));
  nameField.hidden=!signup; nameField.querySelector('input').required=signup;
  signupFields.forEach(field=>{field.hidden=!signup;const control=field.querySelector('input,select');if(control)control.required=signup;});
  password.autocomplete=signup?'new-password':'current-password';
  password.placeholder=signup?'Create a password':'Enter your password';
  password.minLength=signup?12:1;
  title.textContent=signup?'Create your account':'Welcome back';
  intro.textContent=signup?'Create one account to buy, sell, trade, and message members.':'Sign in to manage your listings, offers, and messages.';
  submit.textContent=signup?'Create account':'Sign in'; notice.classList.remove('show','error');
  history.replaceState(null,'',`?mode=${signup?'signup':'login'}`);
}

loginTab.addEventListener('click',()=>setMode('login'));
signupTab.addEventListener('click',()=>setMode('signup'));
authForm.addEventListener('submit',async event=>{
  event.preventDefault();
  const signup=signupTab.classList.contains('active');
  const values=new FormData(authForm);
  const body={email:values.get('email'),password:values.get('password')};
  if(signup)Object.assign(body,{displayName:values.get('displayName'),schoolId:values.get('schoolId'),contactNo:values.get('contactNo')});
  submit.disabled=true; notice.classList.remove('error'); notice.textContent='Please wait…'; notice.classList.add('show');
  try{
    const response=await fetch(`${appBasePath}/api/auth/${signup?'register':'login'}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error||`Request failed (${response.status}).`);
    location.href=`${appBasePath}/marketplace.html`;
  }catch(error){notice.textContent=error.message||'Could not connect to Goodfind. Try again.';notice.classList.add('error');}
  finally{submit.disabled=false;}
});

setMode(new URLSearchParams(location.search).get('mode')==='signup'?'signup':'login');
