'use strict';

const loginTab=document.querySelector('#loginTab');
const signupTab=document.querySelector('#signupTab');
const nameField=document.querySelector('#nameField');
const signupFields=['#schoolField','#contactField'].map(selector=>document.querySelector(selector));
const idPhotoField=document.querySelector('#idPhotoField');
const idPhotoInput=document.querySelector('#idPhoto');
const idPhotoPreview=document.querySelector('#idPhotoPreview');
const displayName=document.querySelector('#displayName');
const schoolId=document.querySelector('#schoolId');
const ocrNameHint=document.querySelector('#ocrNameHint');
const ocrSchoolHint=document.querySelector('#ocrSchoolHint');
const password=document.querySelector('#password');
const confirmPasswordField=document.querySelector('#confirmPasswordField');
const confirmPassword=document.querySelector('#confirmPassword');
const passwordRules=document.querySelector('#passwordRules');
const passwordToggle=document.querySelector('#passwordToggle');
const email=document.querySelector('#email');
const title=document.querySelector('#formTitle');
const intro=document.querySelector('#formIntro');
const submit=document.querySelector('#submitButton');
const notice=document.querySelector('#authnotice');
const authForm=document.querySelector('#authForm');
const appBasePath=new URL('../',location.href).pathname.replace(/\/$/,'');
const initialAuthParams=new URLSearchParams(location.search);
const requestedReturnTo=initialAuthParams.get('returnTo');
let idPhotoData=null;
let ocrRequest=0;
let ocrSchoolValue='';
let ocrNameValue='';
let schoolIdManuallyEdited=false;
let nameManuallyEdited=false;

function passwordChecks(value){return {length:value.length>=12,lower:/[a-z]/.test(value),upper:/[A-Z]/.test(value),digit:/\d/.test(value),special:/[^A-Za-z0-9]/.test(value)};}
function updatePasswordFeedback(){
  const signup=signupTab.classList.contains('active');
  const checks=passwordChecks(password.value);
  passwordRules.querySelectorAll('[data-rule]').forEach(item=>item.classList.toggle('met',Boolean(checks[item.dataset.rule])));
  const valid=Object.values(checks).every(Boolean);
  password.setCustomValidity(signup&&!valid?'Use at least 12 characters with a lowercase letter, uppercase letter, digit, and special character.':'');
  confirmPassword.setCustomValidity(signup&&confirmPassword.value&&confirmPassword.value!==password.value?'Passwords do not match.':'');
}
function togglePasswordVisibility(){
  const show=password.type==='password';
  password.type=show?'text':'password';confirmPassword.type=show?'text':'password';
  passwordToggle.textContent=show?'Hide':'Show';passwordToggle.setAttribute('aria-pressed',String(show));
}

function setMode(mode){
  const signup=mode==='signup';
  const modeChanged=signup!==signupTab.classList.contains('active');
  if(modeChanged)authForm.reset();
  if(modeChanged){idPhotoData=null;idPhotoInput.value='';idPhotoPreview.hidden=true;idPhotoPreview.textContent='';ocrNameHint.hidden=true;ocrSchoolHint.hidden=true;ocrSchoolValue='';ocrNameValue='';schoolIdManuallyEdited=false;nameManuallyEdited=false;}
  authForm.autocomplete=signup?'off':'on';
  email.autocomplete=signup?'off':'username';
  loginTab.classList.toggle('active',!signup); loginTab.setAttribute('aria-selected',String(!signup));
  signupTab.classList.toggle('active',signup); signupTab.setAttribute('aria-selected',String(signup));
  nameField.hidden=!signup; nameField.querySelector('input').required=signup;
  signupFields.forEach(field=>{field.hidden=!signup;const control=field.querySelector('input,select');if(control)control.required=signup;});
  idPhotoField.hidden=!signup;
  password.autocomplete=signup?'new-password':'current-password';
  password.placeholder=signup?'Create a password':'Enter your password';
  password.minLength=signup?12:1;
  confirmPasswordField.hidden=!signup;confirmPassword.required=signup;
  confirmPassword.autocomplete='new-password';confirmPassword.value='';
  passwordRules.hidden=!signup;
  password.type='password';confirmPassword.type='password';passwordToggle.textContent='Show';passwordToggle.setAttribute('aria-pressed','false');
  title.textContent=signup?'Create your account':'Welcome back';
  intro.textContent=signup?'Create one account to buy, sell, trade, and message members.':'Sign in to manage your listings, offers, and messages.';
  submit.textContent=signup?'Create account':'Sign in'; notice.classList.remove('show','error');
  updatePasswordFeedback();
  const query=new URLSearchParams({mode:signup?'signup':'login'});
  if(requestedReturnTo)query.set('returnTo',requestedReturnTo);
  history.replaceState(null,'',`?${query}`);
}

loginTab.addEventListener('click',()=>setMode('login'));
signupTab.addEventListener('click',()=>setMode('signup'));
idPhotoInput.addEventListener('change',async()=>{
  const file=idPhotoInput.files?.[0];if(!file)return;
  if(!file.type.startsWith('image/')){idPhotoInput.value='';notice.textContent='Choose an image of your school ID.';notice.classList.add('show','error');return;}
  const request=++ocrRequest;
  try{
    idPhotoData=await compressIdPhoto(file);
    if(request!==ocrRequest)return;
    idPhotoPreview.innerHTML=`<img src="${idPhotoData}" alt="School ID photo preview">`;idPhotoPreview.hidden=false;
    notice.textContent='Reading the name and school ID from your photo…';notice.classList.remove('error');notice.classList.add('show');
    const found=await scanSchoolId(idPhotoData);
    if(request!==ocrRequest)return;
    let filled=0;
    if(found.name&&(!nameManuallyEdited||!displayName.value.trim())){displayName.value=found.name;ocrNameValue=found.name;nameManuallyEdited=false;filled++;}
    if(found.id&&(!schoolIdManuallyEdited||!schoolId.value.trim())){schoolId.value=found.id;ocrSchoolValue=found.id;schoolIdManuallyEdited=false;filled++;}
    ocrNameHint.textContent=found.name?(displayName.value===found.name?'Filled from your ID photo. Please check the spelling.':'Name found, but your edited entry was kept.'):'Could not confidently read a name. Enter it below.';
    ocrSchoolHint.textContent=found.id?(schoolId.value===found.id?'Filled from your ID photo. Please check every character.':'ID number found, but your edited entry was kept.'):'Could not confidently read an ID number. Enter it below.';
    ocrNameHint.hidden=false;ocrSchoolHint.hidden=false;
    notice.textContent=filled?'We filled in the fields we could read. Please check them before creating your account.':'Photo scanned. Check the fields and enter anything that was not read.';
    notice.classList.remove('error');notice.classList.add('show');
  }
  catch(error){
    if(request!==ocrRequest)return;
    if(idPhotoData){notice.textContent='The photo is ready, but its text could not be scanned. Enter your name and ID number manually.';notice.classList.remove('error');notice.classList.add('show');}
    else{idPhotoInput.value='';notice.textContent=error.message;notice.classList.add('show','error');}
  }
});
password.addEventListener('input',updatePasswordFeedback);
displayName.addEventListener('input',()=>{if(displayName.value!==ocrNameValue)nameManuallyEdited=true;});
schoolId.addEventListener('input',()=>{if(schoolId.value!==ocrSchoolValue)schoolIdManuallyEdited=true;});
confirmPassword.addEventListener('input',updatePasswordFeedback);
passwordToggle.addEventListener('click',togglePasswordVisibility);
authForm.addEventListener('submit',async event=>{
  event.preventDefault();
  const signup=signupTab.classList.contains('active');
  updatePasswordFeedback();
  if(signup&&password.value!==confirmPassword.value){confirmPassword.reportValidity();return;}
  if(signup&&!idPhotoData){notice.textContent='Upload or take a clear photo of your school ID to submit it for verification.';notice.classList.add('show','error');idPhotoField.scrollIntoView({behavior:'smooth',block:'center'});return;}
  const values=new FormData(authForm);
  const body={email:values.get('email'),password:values.get('password')};
  if(signup)Object.assign(body,{displayName:values.get('displayName'),schoolId:values.get('schoolId'),contactNo:values.get('contactNo'),idPhoto:idPhotoData});
  submit.disabled=true; notice.classList.remove('error'); notice.textContent='Please wait…'; notice.classList.add('show');
  try{
    const response=await fetch(`${appBasePath}/api/auth/${signup?'register':'login'}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error||`Request failed (${response.status}).`);
    location.href=safeReturnTo()||`${appBasePath}/marketplace.html`;
  }catch(error){notice.textContent=error.message||'Could not connect to Goodfind. Try again.';notice.classList.add('error');}
  finally{submit.disabled=false;}
});

setMode(new URLSearchParams(location.search).get('mode')==='signup'?'signup':'login');

function safeReturnTo(){
  if(!requestedReturnTo||!requestedReturnTo.startsWith('/')||requestedReturnTo.startsWith('//')||requestedReturnTo.includes('\\'))return'';
  try{const target=new URL(requestedReturnTo,location.origin);return target.origin===location.origin?target.pathname+target.search+target.hash:'';}catch{return'';}
}

function compressIdPhoto(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onerror=()=>reject(new Error('Could not read that ID photo. Try choosing it again.'));
    reader.onload=()=>{const image=new Image();image.onerror=()=>reject(new Error('Could not open that ID photo. Choose a JPG, PNG, or WebP image.'));image.onload=async()=>{
      let scale=Math.min(1,1600/Math.max(image.width,image.height));let blob=null;
      for(let attempt=0;attempt<5;attempt++){const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);blob=await new Promise(done=>canvas.toBlob(done,'image/jpeg',[.88,.82,.76,.7,.64][attempt]));if(blob&&blob.size<=900*1024)break;scale*=.82;}
      if(!blob||blob.size>1024*1024){reject(new Error('That ID photo is too large to process. Choose a smaller image.'));return;}
      const output=new FileReader();output.onerror=()=>reject(new Error('Could not prepare the ID photo.'));output.onload=()=>resolve(output.result);output.readAsDataURL(blob);
    };image.src=reader.result;};reader.readAsDataURL(file);
  });
}

async function scanSchoolId(imageData){
  if(!window.Tesseract?.createWorker)throw new Error('The text scanner is unavailable.');
  const worker=await Tesseract.createWorker('eng',1,{logger:progress=>{
    if(progress.status==='recognizing text'&&Number.isFinite(progress.progress))notice.textContent=`Reading your ID… ${Math.round(progress.progress*100)}%`;
  }});
  try{
    const enhanced=await enhanceIdPhoto(imageData);
    await worker.setParameters({tessedit_pageseg_mode:'6',user_defined_dpi:'300',preserve_interword_spaces:'1'});
    notice.textContent='Reading your ID… pass 1 of 2';
    const first=await worker.recognize(enhanced);
    await worker.setParameters({tessedit_pageseg_mode:'11',user_defined_dpi:'300',preserve_interword_spaces:'1'});
    notice.textContent='Reading your ID… pass 2 of 2';
    const second=await worker.recognize(imageData);
    const one=parseSchoolIdText(first.data.text||'');
    const two=parseSchoolIdText(second.data.text||'');
    return{name:chooseOcrName(one.name,two.name),id:chooseOcrId(one.id,two.id)};
  }finally{await worker.terminate();}
}

function enhanceIdPhoto(source){
  return new Promise((resolve,reject)=>{
    const image=new Image();
    image.onerror=()=>reject(new Error('Could not prepare the ID photo for scanning.'));
    image.onload=()=>{
      const scale=Math.min(1.75,2600/Math.max(image.naturalWidth,image.naturalHeight));
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));
      canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
      const context=canvas.getContext('2d',{willReadFrequently:true});
      if(!context){reject(new Error('Could not prepare the ID photo for scanning.'));return;}
      context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';
      context.drawImage(image,0,0,canvas.width,canvas.height);
      const pixels=context.getImageData(0,0,canvas.width,canvas.height);
      const histogram=new Uint32Array(256);
      const luminance=new Uint8Array(canvas.width*canvas.height);
      for(let offset=0,index=0;offset<pixels.data.length;offset+=4,index++){
        const gray=Math.round(.299*pixels.data[offset]+.587*pixels.data[offset+1]+.114*pixels.data[offset+2]);
        luminance[index]=gray;histogram[gray]++;
      }
      const total=luminance.length;let lower=0,upper=255,seen=0;
      for(let value=0;value<256;value++){seen+=histogram[value];if(seen>=total*.03){lower=value;break;}}
      seen=0;for(let value=255;value>=0;value--){seen+=histogram[value];if(seen>=total*.03){upper=value;break;}}
      const range=Math.max(32,upper-lower);
      for(let offset=0,index=0;offset<pixels.data.length;offset+=4,index++){
        const gray=Math.max(0,Math.min(255,Math.round((luminance[index]-lower)*255/range)));
        pixels.data[offset]=gray;pixels.data[offset+1]=gray;pixels.data[offset+2]=gray;
      }
      context.putImageData(pixels,0,0);
      resolve(canvas.toDataURL('image/png'));
    };
    image.src=source;
  });
}

function parseSchoolIdText(text){
  const lines=text.split(/\r?\n/).map(line=>line.replace(/[|_]/g,' ').replace(/\s+/g,' ').trim()).filter(Boolean);
  let name='';let id='';
  for(let index=0;index<lines.length;index++){
    const line=lines[index];
    const nameMatch=line.match(/\b(?:full\s+name|student(?:'s)?\s+name|name)\b\s*[:#-]?\s*(.*)$/i);
    if(nameMatch){
      const inline=cleanOcrName(nameMatch[1]);
      const next=cleanOcrName(lines[index+1]||'');
      name=inline||next;
      if(name&&name===next&&!nameMatch[1])index++;
      if(name)break;
    }
  }
  if(!name){
    const plausible=lines.map(cleanOcrName).filter(Boolean)
      .map(value=>({value,words:value.split(/\s+/).length}))
      .filter(item=>item.words>=2&&item.words<=6)
      .sort((a,b)=>nameLineScore(b.value)-nameLineScore(a.value));
    name=plausible[0]?.value||'';
  }
  const idLabel=/\b(?:school\s*)?(?:student\s*)?id(?:\s*(?:no\.?|number|#))?\b/i;
  const candidates=[];
  for(let index=0;index<lines.length;index++){
    const line=lines[index];
    const labelMatch=line.match(idLabel);
    if(labelMatch){
      const afterLabel=line.slice(labelMatch.index+labelMatch[0].length).replace(/^\s*[:#-]?\s*/,'');
      const inline=extractIdCandidates(afterLabel).find(isPlausibleSchoolId);
      const next=extractIdCandidates(lines[index+1]||'').find(isPlausibleSchoolId);
      if(inline||next){id=inline||next;break;}
    }
    candidates.push(...extractIdCandidates(line));
  }
  if(!id){
    const compact=candidates.map(value=>value.replace(/\s+/g,''));
    id=compact.find(value=>/^LODS\s*8[A-Z0-9-]*$/i.test(value))||
      compact.filter(value=>/^\d{6,12}$/.test(value)).sort((a,b)=>b.length-a.length)[0]||'';
  }
  return{name,id};
}

function nameLineScore(value){
  const words=value.split(/\s+/);
  const titleCase=words.every(word=>/^\p{Lu}[\p{Ll}]+(?:['-]\p{Lu}?[\p{Ll}]+)*$/u.test(word));
  const upperCase=value===value.toLocaleUpperCase();
  return(words.length>=2&&words.length<=4?4:0)+
    (titleCase?3:0)+(upperCase?5:0)+(value.includes(',')?2:0)+
    (words.every(word=>/^\p{L}[\p{L}'.-]*$/u.test(word))?3:0)-
    (/\d/.test(value)?10:0);
}

function chooseOcrName(first,second){
  if(!first)return second||'';if(!second)return first;
  return nameLineScore(second)>nameLineScore(first)?second:first;
}

function chooseOcrId(first,second){
  if(!first)return second||'';if(!second)return first;
  const score=value=>(/^LODS\s*8/i.test(value)?20:0)+(/^\d{6,12}$/.test(value)?10:0);
  return score(second)>score(first)?second:first;
}

function isPlausibleSchoolId(value){return /^LODS\s*8[A-Z0-9-]*$/i.test(value)||/^\d{6,12}$/.test(value)||/^[A-Z]{2,5}\d{5,12}$/i.test(value);}

function extractIdCandidates(value){
  const merged=value.replace(/\b([A-Z]{2,})\s+(\d{1,})\b/gi,'$1$2');
  return (merged.match(/\b[A-Z0-9](?:[A-Z0-9-]{2,}[A-Z0-9])?\b/gi)||[])
    .map(candidate=>candidate.replace(/^-+|-+$/g,'').toUpperCase())
    .filter(candidate=>candidate.length>=4&&candidate.length<=18&&/\d/.test(candidate)&&!/^\d{4}$/.test(candidate));
}

function cleanOcrName(value){
  const cleaned=value.replace(/\b(?:student\s*)?id(?:\s*(?:no\.?|number))?\b.*$/i,'').replace(/[^\p{L}\p{M}.' -]/gu,' ').replace(/\s+/g,' ').trim();
  if(cleaned.length<5||cleaned.length>70||!/[a-z]/i.test(cleaned)||!/[\s]/.test(cleaned))return'';
  if(/\b(?:university|college|school|student|republic|department|issued|valid|birth|address|barangay|province|city|davao|panabo|campus|course|program|grade|section|nationality|signature|emergency|contact|blood|type|male|female)\b/i.test(cleaned))return'';
  return cleaned;
}
