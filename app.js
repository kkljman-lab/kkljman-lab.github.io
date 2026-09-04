const money = new Intl.NumberFormat('zh-TW', {style:'currency', currency:'TWD', maximumFractionDigits:0});
const maskMoney = n => $('#privacy-toggle')?.checked ? '***' : money.format(n);
let accounts = [];
let splitMode = false;
let saveAndContinue = false;
let transactionTypeFilter = null;
let currentDetail = null;
let categoryManageMode = false;
let currentExchangeRate = null;
let detailCategorySide = 'debit';
let detailCounterpartId = null;
let detailRateSource = null;
const $ = selector => document.querySelector(selector);
const escapeHtml = value => { const node=document.createElement('div'); node.textContent=value??''; return node.innerHTML; };
function showToast(message){let toast=$('#toast');if(!toast){toast=document.createElement('div');toast.id='toast';toast.style.cssText='position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:#173f35;color:white;padding:12px 18px;border-radius:999px;box-shadow:0 8px 24px #0004;z-index:20;font-weight:700';document.body.append(toast)}toast.textContent=message;toast.hidden=false;clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>toast.hidden=true,2200)}
function setupDialogBackButtons(){[['#entry-dialog','#entry-back'],['#detail-dialog','#detail-back']].forEach(([dialogSelector,id])=>{const dialog=$(dialogSelector),title=dialog.querySelector('.dialog-title'),button=document.createElement('button');button.type='button';button.id=id.slice(1);button.className='icon-button';button.setAttribute('aria-label','上一頁');button.textContent='‹';button.style.cssText='flex:0 0 44px;font-size:34px;margin-right:9px';title.prepend(button);const middle=button.nextElementSibling;if(middle){middle.style.flex='1';middle.style.textAlign='center'}button.addEventListener('click',()=>dialog.close())})}
function setupMainMenu(){const findButton=text=>[...document.querySelectorAll('main button')].find(button=>button.textContent.trim()===text),originals={annual:findButton('年度收支統計'),categories:findButton('管理分類'),stocks:findButton('股票持股'),exportCsv:findButton('匯出 CSV'),importCsv:findButton('匯入 CSV')};Object.values(originals).forEach(button=>{const section=button?.closest('section');if(section)section.style.display='none'});const header=document.querySelector('header'),title=header.querySelector('div'),open=document.createElement('button');open.type='button';open.id='main-menu-open';open.textContent='☰';open.setAttribute('aria-label','主選單');header.insertBefore(open,title);const menu=document.createElement('dialog');menu.id='main-menu-dialog';menu.innerHTML='<div class="main-menu-shell"><section class="menu-profile"><button type="button" class="menu-close" id="main-menu-close" aria-label="關閉主選單">×</button><h2 class="menu-title">主選單</h2><div class="menu-profile-rule"></div></section><nav class="menu-actions" aria-label="帳本功能"><button type="button" id="menu-annual"><span>📊</span>年度收支統計</button><button type="button" id="menu-categories"><span>◫</span>管理分類</button><button type="button" id="menu-stocks"><span>📈</span>股票持股</button><button type="button" id="menu-export"><span>⬇</span>匯出 CSV</button><button type="button" id="menu-import"><span>⬆</span>匯入 CSV</button><button type="button" id="menu-backup"><span>☁</span>帳務同步</button></nav></div>';document.body.append(menu);let menuSX=0,menuSY=0,menuTracking=false;menu.addEventListener('touchstart',e=>{const t=e.touches[0];menuSX=t.clientX;menuSY=t.clientY;menuTracking=true},{passive:true});menu.addEventListener('touchend',e=>{if(!menuTracking)return;menuTracking=false;const t=e.changedTouches[0],dx=t.clientX-menuSX,dy=t.clientY-menuSY;if(dx<-40&&Math.abs(dx)>Math.abs(dy)*1.5){menu.style.transition='transform .22s ease, opacity .22s ease';menu.style.transform='translateX(-100%)';menu.style.opacity='0';setTimeout(()=>{menu.close();menu.style.transition='';menu.style.transform='';menu.style.opacity=''},220)}},{passive:true});open.addEventListener('click',()=>menu.showModal());$('#main-menu-close').addEventListener('click',()=>menu.close());$('#menu-annual').addEventListener('click',()=>{menu.close();originals.annual?.click()});$('#menu-categories').addEventListener('click',()=>{menu.close();originals.categories?.click()});$('#menu-stocks').addEventListener('click',()=>{menu.close();originals.stocks?.click()});$('#menu-export').addEventListener('click',()=>{menu.close();originals.exportCsv?.click()});$('#menu-import').addEventListener('click',()=>{menu.close();originals.importCsv?.click()});const add=$('#add');add.style.left='50%';add.style.right='auto';add.style.transform='translateX(-50%)'}
function setupCloudSettings(){const dialog=document.createElement('dialog');dialog.id='cloud-settings-dialog';dialog.innerHTML='<form id="cloud-settings-form" style="padding:22px"><div class="dialog-title"><h2>設定</h2><button type="button" class="icon-button" id="cloud-settings-close">×</button></div><section class="notice"><strong>Google 帳號登入</strong><p style="margin:7px 0">狀態：尚未啟用</p></section><section style="margin-top:18px"><h3>Google Drive 加密備份</h3><p id="google-drive-status" class="muted">尚未連結 Google Drive</p><button type="button" id="google-connect" class="secondary">連結 Google 帳號</button><label style="grid-template-columns:auto 1fr;align-items:center"><input id="cloud-backup-enabled" type="checkbox" style="width:22px;height:22px"> 啟用每日雲端備份</label><label>每天備份時間<input id="cloud-backup-time" type="time" value="03:00"></label><small class="muted">排程會在完成 Google Drive 授權與加密金鑰設定後正式啟用。</small></section><p id="cloud-settings-message" class="muted"></p><button type="submit" style="margin-top:18px">儲存設定</button></form>';document.body.append(dialog);$('#cloud-settings-close').addEventListener('click',()=>dialog.close())}
function setupExchangeRate(){const panel=document.createElement('section');panel.id='exchange-panel';panel.style.cssText='margin:12px 0;padding:12px;border:1px solid #d9ded9;border-radius:14px;background:#f8faf8';panel.innerHTML='<label>幣別<select id="entry-currency"><option value="TWD">新台幣 TWD</option><option value="JPY">日幣 JPY</option><option value="CNY">人民幣 CNY</option><option value="USD">美金 USD</option></select></label><div id="exchange-result" hidden><label>當下匯率（1 外幣 = 新台幣）<input id="entry-rate" readonly inputmode="decimal"></label><p id="exchange-converted" style="font-weight:800;margin:8px 0 2px"></p><small id="exchange-source" class="muted"></small></div>';$('#simple-entry .amount-field').before(panel);const detail=document.createElement('p');detail.id='detail-exchange';detail.className='notice';detail.hidden=true;$('#detail-memo').closest('label').after(detail);$('#entry-currency').addEventListener('change',loadExchangeRate);$('#entry-amount').addEventListener('input',updateConvertedAmount)}
async function loadExchangeRate(){const currency=$('#entry-currency').value;currentExchangeRate=null;$('#exchange-result').hidden=currency==='TWD';$('#entry-amount').step=currency==='TWD'?'1':'0.01';$('#entry-amount').min=currency==='TWD'?'1':'0.01';$('.amount-field small').textContent=currency;if(currency==='TWD')return;$('#entry-rate').value='';$('#exchange-converted').textContent='取得匯率中…';$('#exchange-source').textContent='';try{const response=await fetch('/api/exchange-rate?currency='+currency);const result=await response.json();if(!response.ok)throw new Error(result.error||'無法取得匯率');currentExchangeRate=result;$('#entry-rate').value=result.twd_rate;const kind=result.rate_kind==='spot_sell'?'即期賣出參考價':'參考匯率';$('#exchange-source').textContent=`${result.source_name}・${kind}${result.quoted_at?'・'+result.quoted_at:''}${result.stale?'・暫用最近一筆匯率':''}`;updateConvertedAmount()}catch(error){$('#exchange-converted').textContent='';$('#exchange-source').textContent=error.message;$('#form-error').textContent=error.message}}
function updateConvertedAmount(){if($('#entry-currency')?.value==='TWD')return;const amount=Number($('#entry-amount').value),rate=Number($('#entry-rate').value);$('#exchange-converted').textContent=amount>0&&rate>0?`約 ${money.format(Math.round(amount*rate))}`:'請輸入外幣金額'}
function setupSimplifiedDetail(){const fields=document.createElement('section');fields.id='detail-simple-fields';fields.innerHTML='<label>分類<select id="detail-category" required></select></label><label>金額<input id="detail-amount" type="number" min="0.01" step="0.01" inputmode="decimal" required></label><label>匯率（1 外幣 = 新台幣）<input id="detail-rate" type="number" min="0.000001" step="0.000001" inputmode="decimal" required></label><label>幣值<select id="detail-currency"><option value="TWD">新台幣 TWD</option><option value="JPY">日幣 JPY</option><option value="CNY">人民幣 CNY</option><option value="USD">美金 USD</option></select></label><small id="detail-converted" class="muted"></small>';$('#detail-date').closest('.date-nav').after(fields);$('#add-entry').closest('.section-title').hidden=true;$('#detail-entries').hidden=true;$('#legacy-note').hidden=true;$('#add-entry').hidden=true;$('#detail-currency').addEventListener('change',async()=>{const currency=$('#detail-currency').value;if(currency==='TWD'){$('#detail-rate').value='1';detailRateSource=null;updateDetailConverted();return}try{const response=await fetch('/api/exchange-rate?currency='+currency),result=await response.json();if(response.ok){$('#detail-rate').value=result.twd_rate;detailRateSource=result;updateDetailConverted()}}catch(error){}});$('#detail-amount').addEventListener('input',updateDetailConverted);$('#detail-rate').addEventListener('input',updateDetailConverted)}
function updateDetailConverted(){const amount=Number($('#detail-amount')?.value),rate=Number($('#detail-rate')?.value);$('#detail-converted').textContent=amount>0&&rate>0?`入帳金額：${money.format(Math.round(amount*rate))}`:''}
let detailFastGroup='',detailFastType='expense',detailCalcStored=null,detailCalcOperator=null;
function calculateDetailAmount(right){const left=detailCalcStored,op=detailCalcOperator;if(left===null||!op)return right;if(op==='÷')return right===0?left:left/right;if(op==='×')return left*right;if(op==='＋')return left+right;return left-right}
function updateDetailFastAmount(){if(!$('#detail-fast-amount'))return;$('#detail-fast-amount').textContent=$('#detail-amount').value||'0';$('#detail-fast-currency').textContent=$('#detail-currency').value||'TWD'}
function setupDetailFastUI(){const section=document.createElement('section');section.id='detail-fast-ui';section.style.cssText='border:1px solid #d9ded9;border-radius:16px;padding:12px;margin-top:12px';section.innerHTML='<div id="detail-fast-controls" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px"><label style="margin:0">帳戶<select id="detail-fast-account"></select></label><label style="margin:0">類型<select id="detail-fast-type"><option value="expense">支出</option><option value="income">收入</option></select></label><label style="margin:0">分類<select id="detail-fast-group"></select></label></div><div id="detail-fast-tabs-row" style="display:flex;gap:8px;align-items:center;margin-top:8px"><div id="detail-fast-tabs" style="display:flex;gap:6px;overflow-x:auto;padding-bottom:5px;flex:1"></div></div><div id="detail-fast-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px"></div><div id="detail-fast-memo"></div><div style="margin-top:4px;background:#173f35;color:white;border-radius:14px;padding:4px 10px"><small id="detail-fast-currency" style="opacity:.75">TWD</small><span id="detail-rate-slot" style="margin-left:6px;font-size:.78rem;opacity:.85"></span><strong id="detail-fast-amount" style="display:block;font-size:26px;text-align:right">0</strong></div><div id="detail-fast-keypad" style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin-top:4px"></div>';$('#detail-date').closest('.date-nav').after(section);$('#detail-fast-memo').append($('#detail-memo').closest('label'));const normal=['7','8','9','÷','AC','4','5','6','×','⌫','1','2','3','＋'];$('#detail-fast-keypad').innerHTML=normal.map(key=>`<button type="button" data-detail-key="${key}" class="${['÷','×','＋','AC','⌫'].includes(key)?'secondary':''}" style="min-height:46px;padding:4px 3px;font-size:20px">${key}</button>`).join('')+'<button type="button" data-detail-key="儲存修改" style="grid-row:span 2;min-height:46px;padding:4px 3px;font-size:13px;background:#2684ff">儲存修改</button>'+['.','0','00','－'].map(key=>`<button type="button" data-detail-key="${key}" class="${key==='－'?'secondary':''}" style="min-height:46px;padding:4px 3px;font-size:20px">${key}</button>`).join('');$('#detail-fast-keypad').addEventListener('click',event=>{const button=event.target.closest('[data-detail-key]');if(!button)return;const key=button.dataset.detailKey,input=$('#detail-amount');if(key==='儲存修改'){if(Number(input.value)>0)$('#detail-form').requestSubmit();return}if(['÷','×','＋','－'].includes(key)){const current=Number(input.value)||0;if(detailCalcStored!==null&&detailCalcOperator)detailCalcStored=calculateDetailAmount(current);else detailCalcStored=current;detailCalcOperator=key;input.value='';updateDetailFastAmount();return}if(key==='AC'){input.value='';detailCalcStored=null;detailCalcOperator=null}else if(key==='⌫')input.value=input.value.slice(0,-1);else if(key==='.'&&!input.value.includes('.'))input.value=(input.value||'0')+'.';else if(key!=='.')input.value=(input.value==='0'?'':input.value)+key;if(detailCalcStored!==null&&detailCalcOperator&&input.value){const result=calculateDetailAmount(Number(input.value));$('#detail-fast-amount').textContent=`${detailCalcStored} ${detailCalcOperator} ${input.value} = ${Number(result.toFixed(6))}`}else updateDetailFastAmount();updateDetailConverted()});$('#detail-fast-account').addEventListener('change',()=>detailCounterpartId=$('#detail-fast-account').value);$('#detail-fast-type').addEventListener('change',()=>{detailFastType=$('#detail-fast-type').value;detailFastGroup=detailFastType==='expense'?'生活飲食':'';detailCategorySide=detailFastType==='expense'?'debit':'credit';renderDetailFastEditor(false)});$('#detail-fast-group').addEventListener('change',()=>{detailFastGroup=$('#detail-fast-group').value;renderDetailFastEditor(false)});$('#detail-form').addEventListener('submit',()=>{if(detailCalcStored!==null&&detailCalcOperator){const result=calculateDetailAmount(Number($('#detail-amount').value)||0);$('#detail-amount').value=String(Number(result.toFixed(6)));detailCalcStored=null;detailCalcOperator=null;updateDetailFastAmount()}},true);$('#detail-simple-fields').style.display='none';$('#save-detail').style.display='none';$('#detail-form .section-title').style.display='none'}
async function renderDetailFastEditor(initial=true){if(!currentDetail||!$('#detail-fast-ui'))return;if(initial){const categoryEntry=currentDetail.entries.find(entry=>entry.account_type==='expense')||currentDetail.entries.find(entry=>entry.account_type==='income');detailFastType=categoryEntry?.account_type||'expense';detailCategorySide=detailFastType==='expense'?'debit':'credit';detailCounterpartId=currentDetail.entries.find(entry=>entry.id!==categoryEntry?.id)?.account_id||detailCounterpartId;const categoryAccount=accounts.find(account=>account.id===categoryEntry?.account_id);detailFastGroup=categoryAccount?.parent_name||(detailFastType==='expense'?'生活飲食':'');detailCalcStored=null;detailCalcOperator=null}$('#detail-fast-type').value=detailFastType;const accountTypes=detailFastType==='expense'?['asset','liability']:['asset'];$('#detail-fast-account').innerHTML=accountOptions(accountTypes);if([...$('#detail-fast-account').options].some(option=>option.value===detailCounterpartId))$('#detail-fast-account').value=detailCounterpartId;else{const cash=[...$('#detail-fast-account').options].find(option=>option.textContent.trim()==='現金');$('#detail-fast-account').value=cash?.value||$('#detail-fast-account').options[0]?.value;detailCounterpartId=$('#detail-fast-account').value}const data=await fetch('/api/categories?type='+detailFastType).then(response=>response.json()),items=[...data.favorites,...data.available],groups=[...new Set(items.map(item=>item.group_name||'其他'))];if(!groups.includes(detailFastGroup))detailFastGroup=detailFastType==='expense'&&groups.includes('生活飲食')?'生活飲食':groups[0]||'其他';$('#detail-fast-group').innerHTML=groups.map(group=>`<option value="${escapeHtml(group)}" ${group===detailFastGroup?'selected':''}>${escapeHtml(group)}</option>`).join('');$('#detail-fast-tabs').innerHTML=groups.map(group=>`<button type="button" data-detail-group="${escapeHtml(group)}" class="${group===detailFastGroup?'':'secondary'}" style="width:auto;white-space:nowrap;padding:10px 14px;font-size:14px">${escapeHtml(group)}</button>`).join('');$('#detail-fast-tabs').querySelectorAll('[data-detail-group]').forEach(button=>button.addEventListener('click',()=>{detailFastGroup=button.dataset.detailGroup;renderDetailFastEditor(false)}));const categories=items.filter(item=>(item.group_name||'其他')===detailFastGroup),current=$('#detail-category').value;$('#detail-category').innerHTML=categories.map(item=>`<option value="${item.id}" ${item.id===current?'selected':''}>${escapeHtml(item.name)}</option>`).join('');if(!$('#detail-category').value&&categories[0])$('#detail-category').value=categories[0].id;const chosen=$('#detail-category').value;$('#detail-fast-grid').innerHTML=categories.map(item=>`<button type="button" data-detail-category="${item.id}" style="min-height:74px;padding:2px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;background:${item.id===chosen?'#e4f1ec':'#f5f6f4'};color:#17231f;border:${item.id===chosen?'3px solid #2684ff':'1px solid #e1e5e2'}"><span style="font-size:26px;line-height:1">${categoryIcon(item.name,item.icon)}</span><small style="font-size:.82rem;line-height:1.1">${escapeHtml(item.name)}</small></button>`).join('');$('#detail-fast-grid').querySelectorAll('[data-detail-category]').forEach(button=>button.addEventListener('click',()=>{$('#detail-category').value=button.dataset.detailCategory;renderDetailFastEditor(false)}));updateDetailFastAmount()}
const currencyOptions='<option value="TWD">新台幣</option><option value="JPY">日幣</option><option value="CNY">人民幣</option><option value="USD">美金</option>';
function manualRateSnapshot(currency,rate,base={}){return{currency,twd_rate:String(rate),rate_kind:'manual',source_name:'手動輸入',source_url:base.source_url||'',quoted_at:base.quoted_at||null}}
function setupVisibleExchangeControls(){$('#fast-memo-slot').style.cssText='display:grid;grid-template-columns:1fr 108px;gap:8px;align-items:center';const currencySelect=document.createElement('select');currencySelect.id='fast-currency-select';currencySelect.setAttribute('aria-label','幣值');currencySelect.innerHTML=currencyOptions;$('#fast-memo-slot').append(currencySelect);const rateInput=document.createElement('input');rateInput.id='fast-rate-input';rateInput.type='text';rateInput.readOnly=true;rateInput.tabIndex=-1;rateInput.value='1.00';rateInput.setAttribute('aria-label','匯率（1 外幣 = 新台幣）');rateInput.style.cssText='width:52px;padding:0;font-size:.78rem;background:transparent;color:#fff;border:0;text-align:left';$('#fast-rate-slot').hidden=true;$('#fast-rate-slot').append(document.createTextNode('1：'),rateInput);$('#detail-fast-memo').style.cssText='display:grid;grid-template-columns:1fr 108px;gap:8px;align-items:center';const detailCurrencySelect=document.createElement('select');detailCurrencySelect.id='detail-fast-currency-select';detailCurrencySelect.setAttribute('aria-label','幣值');detailCurrencySelect.innerHTML=currencyOptions;$('#detail-fast-memo').append(detailCurrencySelect);const detailRateInput=document.createElement('input');detailRateInput.id='detail-fast-rate-input';detailRateInput.type='text';detailRateInput.readOnly=true;detailRateInput.tabIndex=-1;detailRateInput.value='1.00';detailRateInput.setAttribute('aria-label','匯率（1 外幣 = 新台幣）');detailRateInput.style.cssText='width:52px;padding:0;font-size:.78rem;background:transparent;color:#fff;border:0;text-align:left';$('#detail-rate-slot').hidden=true;$('#detail-rate-slot').append(document.createTextNode('1：'),detailRateInput);$('#fast-currency-select').addEventListener('change',async()=>{const currency=$('#fast-currency-select').value;$('#entry-currency').value=currency;$('#fast-rate-slot').hidden=currency==='TWD';if(currency==='TWD'){$('#entry-rate').value='1';$('#fast-rate-input').value='1.00';currentExchangeRate=null}else{try{const response=await fetch('/api/exchange-rate?currency='+currency),result=await response.json();if(!response.ok)throw new Error(result.error||'無法取得匯率');currentExchangeRate=result;$('#entry-rate').value=result.twd_rate;$('#fast-rate-input').value=Number(result.twd_rate).toFixed(2)}catch(error){$('#form-error').textContent=error.message+'，暫時以匯率 1 計算，請確認後再儲存';$('#entry-rate').value='1';$('#fast-rate-input').value='1.00'}}updateFastAmount();updateConvertedAmount()});$('#detail-fast-currency-select').addEventListener('change',async()=>{const currency=$('#detail-fast-currency-select').value;$('#detail-currency').value=currency;$('#detail-rate-slot').hidden=currency==='TWD';if(currency==='TWD'){$('#detail-rate').value='1';$('#detail-fast-rate-input').value='1.00';detailRateSource=null}else{try{const response=await fetch('/api/exchange-rate?currency='+currency),result=await response.json();if(!response.ok)throw new Error(result.error||'無法取得匯率');detailRateSource=result;$('#detail-rate').value=result.twd_rate;$('#detail-fast-rate-input').value=Number(result.twd_rate).toFixed(2)}catch(error){$('#detail-error').textContent=error.message+'，暫時以匯率 1 計算，請確認後再儲存';$('#detail-rate').value='1';$('#detail-fast-rate-input').value='1.00'}}updateDetailFastAmount();updateDetailConverted()});}
function syncVisibleExchangeControls(){if($('#fast-currency-select')){$('#fast-currency-select').value=$('#entry-currency').value||'TWD';$('#fast-rate-input').value=Number($('#entry-rate').value||'1').toFixed(2);$('#fast-rate-slot').hidden=$('#fast-currency-select').value==='TWD'}if($('#detail-fast-currency-select')){$('#detail-fast-currency-select').value=$('#detail-currency').value||'TWD';$('#detail-fast-rate-input').value=Number($('#detail-rate').value||'1').toFixed(2);$('#detail-rate-slot').hidden=$('#detail-fast-currency-select').value==='TWD';updateDetailFastAmount()}}
function polishFastLayouts(){[['#fast-entry-controls','#fast-group-select','#fast-major-tabs','#fast-category-grid','#fast-memo-slot','#fast-exchange-controls','74px'],['#detail-fast-ui > div','#detail-fast-group','#detail-fast-tabs','#detail-fast-grid','#detail-fast-memo','#detail-fast-exchange-controls','74px']].forEach(([controlsSelector,groupSelector,tabsSelector,gridSelector,memoSelector,exchangeSelector,rowHeight])=>{const group=$(groupSelector),controls=$(controlsSelector),tabs=$(tabsSelector),grid=$(gridSelector),memo=$(memoSelector),exchange=$(exchangeSelector);if(group?.closest('label'))group.closest('label').style.display='none';if(controls)controls.style.gridTemplateColumns='repeat(2,minmax(0,1fr))';if(tabs?.parentElement)tabs.parentElement.style.alignItems='start';if(grid){grid.style.gridAutoRows=rowHeight;grid.style.height=`calc(${rowHeight} * 2 + 6px)`;grid.style.alignContent='start';grid.style.overflowY='auto';grid.style.overscrollBehavior='contain';grid.style.paddingRight='4px'}if(memo?.querySelector('label'))memo.querySelector('label').style.marginBottom='0';if(exchange){exchange.style.margin='0';exchange.style.width='100%';exchange.querySelectorAll('label').forEach(label=>label.style.margin='8px 0 0')}})}
function setupDataTransfer(){const bar=document.createElement('section');bar.style.cssText='display:flex;gap:8px;justify-content:flex-end;margin-bottom:12px';const exportButton=document.createElement('button');exportButton.type='button';exportButton.className='secondary';exportButton.textContent='匯出 CSV';exportButton.style.width='auto';const importButton=document.createElement('button');importButton.type='button';importButton.className='secondary';importButton.textContent='匯入 CSV';importButton.style.width='auto';const picker=document.createElement('input');picker.type='file';picker.accept='.csv,text/csv';picker.hidden=true;bar.append(exportButton,importButton,picker);document.querySelector('main').insertBefore(bar,$('.view-tabs'));exportButton.addEventListener('click',()=>location.href='/api/export');importButton.addEventListener('click',()=>picker.click());picker.addEventListener('change',async()=>{const file=picker.files[0];if(!file)return;if(!confirm(`確定匯入 ${file.name}？系統會先檢查格式及重複資料。`)){picker.value='';return}importButton.disabled=true;importButton.textContent='匯入中…';try{const response=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'text/csv','X-Filename':'import.csv'},body:file});const result=await response.json();if(!response.ok)throw new Error(result.error||'匯入失敗');alert(`匯入完成：新增 ${result.imported_transactions} 筆，略過重複 ${result.skipped_transactions} 筆。`);location.reload()}catch(error){alert(error.message);importButton.disabled=false;importButton.textContent='匯入 CSV';picker.value=''}})}
function categoryIcon(name,icon){if(icon)return icon;const icons=[[/早餐|早點/,'🍞'],[/午餐|便當/,'🍱'],[/晚餐/,'🍽️'],[/宵夜/,'🌙'],[/飲料|咖啡/,'☕'],[/蔬菜|水果|肉類/,'🥬'],[/點心|零食/,'🍪'],[/聚餐/,'🥂'],[/電子發票|發票/,'🧾'],[/投資損失/,'📉'],[/運動|健身/,'🏋️'],[/電影/,'🎬'],[/旅遊|度假/,'✈️'],[/上課|進修|教育/,'🎓'],[/書籍|書本/,'📚'],[/手機|網路|通訊/,'📱'],[/機車油|汽車油|油費/,'⛽'],[/修理|維修/,'🔧'],[/停車/,'🅿️'],[/交通工具|交通|車票/,'🚆'],[/生活雜物|日用品/,'🧴'],[/裝修|傢飾|家飾/,'🛋️'],[/置裝|服飾|衣服/,'👕'],[/美容|養生/,'💆'],[/婚喪|喜慶/,'💒'],[/送禮|請客/,'🎁'],[/孝親/,'👪'],[/慈善|捐款/,'🤝'],[/掛號|醫療/,'🏥'],[/健康檢查|健檢/,'🩺'],[/藥物|藥品/,'💊'],[/保健食品/,'🍎'],[/汽機車險/,'🚗'],[/保險/,'🛡️'],[/綜所稅|稅金|稅/,'🧾'],[/遊戲|軟體|玩具|娛樂/,'🎮'],[/手續費/,'💳'],[/薪資|薪水|工資/,'💼'],[/兼職|副業/,'🧑‍💻'],[/三節獎金|年終獎金|業績獎金|獎金/,'🧧'],[/利息|股息/,'💰'],[/租金收入|房租/,'🏘️'],[/投資收入|投資/,'📈'],[/回饋/,'🎟️'],[/其他|其它/,'➕'],[/購物/,'🛍️'],[/房屋|住屋|居家/,'🏠']];return(icons.find(([pattern])=>pattern.test(name))||[null,'🏷️'])[1]}
let fastEntryGroup='生活飲食',fastEntryFirstOpen=true,fastCalcStored=null,fastCalcOperator=null;
function calculateFastAmount(right){const left=fastCalcStored,op=fastCalcOperator;if(left===null||!op)return right;if(op==='÷')return right===0?left:left/right;if(op==='×')return left*right;if(op==='＋')return left+right;return left-right}
function setupFastEntryUI(){const section=$('#quick-categories');section.innerHTML='<div id="fast-entry-ui"><div id="fast-entry-controls" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px"><label style="margin:0">帳戶<select id="fast-account"></select></label><label style="margin:0">類型<select id="fast-type"><option value="expense">支出</option><option value="income">收入</option><option value="transfer">轉帳</option></select></label><label style="margin:0">分類<select id="fast-group-select"></select></label></div><div id="fast-major-tabs-row" style="display:flex;gap:8px;align-items:center;margin-top:8px"><div id="fast-major-tabs" style="display:flex;gap:6px;overflow-x:auto;padding-bottom:5px;flex:1"></div></div><div id="fast-category-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px"></div><div id="fast-memo-slot"></div><div style="margin-top:4px;background:#173f35;color:white;border-radius:14px;padding:4px 10px"><small id="fast-currency-label" style="opacity:.75">TWD</small><span id="fast-rate-slot" style="margin-left:6px;font-size:.78rem;opacity:.85"></span><strong id="fast-amount-display" style="display:block;font-size:26px;text-align:right">0</strong></div><div id="fast-keypad" style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin-top:4px"></div></div>';$('#fast-memo-slot').append($('#entry-memo').closest('label'));const normalKeys=['7','8','9','÷','AC','4','5','6','×','⌫','1','2','3','＋'];$('#fast-keypad').innerHTML=normalKeys.map(key=>`<button type="button" data-key="${key}" class="${['AC','⌫','÷','×','＋'].includes(key)?'secondary':''}" style="min-height:46px;padding:4px 3px;font-size:20px">${key}</button>`).join('')+'<button type="button" data-key="確定" style="grid-row:span 2;min-height:46px;padding:4px 3px;font-size:18px;background:#2684ff">確定</button>'+['.','0','00','－'].map(key=>`<button type="button" data-key="${key}" class="${key==='－'?'secondary':''}" style="min-height:46px;padding:4px 3px;font-size:20px">${key}</button>`).join('');$('#fast-keypad').addEventListener('click',event=>{const button=event.target.closest('[data-key]');if(!button)return;const key=button.dataset.key,input=$('#entry-amount');if(key==='確定'){if(Number(input.value)>0){saveAndContinue=false;$('#entry-form').requestSubmit()}return}if(['÷','×','＋','－'].includes(key)){const current=Number(input.value)||0;if(fastCalcStored!==null&&fastCalcOperator)fastCalcStored=calculateFastAmount(current);else fastCalcStored=current;fastCalcOperator=key;input.value='';updateFastAmount();return}if(key==='AC'){input.value='';fastCalcStored=null;fastCalcOperator=null}else if(key==='⌫')input.value=input.value.slice(0,-1);else if(key==='.'&&!input.value.includes('.'))input.value=(input.value||'0')+'.';else if(key!=='.')input.value=(input.value==='0'?'':input.value)+key;if(fastCalcStored!==null&&fastCalcOperator&&input.value){const result=calculateFastAmount(Number(input.value));$('#fast-amount-display').textContent=`${fastCalcStored} ${fastCalcOperator} ${input.value} = ${Number(result.toFixed(6))}`}else updateFastAmount();updateConvertedAmount()});$('#fast-account').addEventListener('change',()=>{const type=$('#entry-type').value;if(type==='expense')$('#credit-account').value=$('#fast-account').value;else if(type==='income')$('#debit-account').value=$('#fast-account').value});$('#fast-type').addEventListener('change',()=>{$('#entry-type').value=$('#fast-type').value;fastEntryGroup=$('#fast-type').value==='expense'?'生活飲食':'';configureEntryForm();renderFastEntryCategories()});$('#fast-group-select').addEventListener('change',()=>{fastEntryGroup=$('#fast-group-select').value;renderFastEntryCategories()});$('#entry-amount').addEventListener('input',updateFastAmount);$('#entry-currency').addEventListener('change',updateFastAmount);$('#entry-type').closest('label').style.display='none';$('#toggle-split').style.display='none';$('#exchange-panel').style.display='none';$('#simple-entry').querySelectorAll('.account-field,.amount-field').forEach(element=>element.style.display='none');loadQuickCategories=renderFastEntryCategories;renderFastEntryCategories()}
function updateFastAmount(){if(!$('#fast-amount-display'))return;$('#fast-amount-display').textContent=$('#entry-amount').value||'0';$('#fast-currency-label').textContent=$('#entry-currency')?.value||'TWD'}
async function renderFastEntryCategories(){if(!$('#fast-entry-ui'))return;const type=$('#entry-type').value;$('#fast-type').value=type;if(type==='transfer'){$('#fast-major-tabs').innerHTML='';$('#fast-category-grid').innerHTML='<span class="muted" style="grid-column:1/-1">轉帳請使用下方的轉入與轉出帳戶</span>';$('#fast-group-select').innerHTML='<option>轉帳</option>';$('#credit-label').hidden=false;$('#debit-label').hidden=false;$('.amount-field').hidden=true;return}$('#credit-label').hidden=true;$('#debit-label').hidden=true;$('.amount-field').hidden=true;const accountSelect=type==='expense'?$('#credit-account'):$('#debit-account'),accountTypes=type==='expense'?['asset','liability']:['asset'];$('#fast-account').innerHTML=accountOptions(accountTypes);let selected=accountSelect.value;const cash=[...$('#fast-account').options].find(x=>x.textContent.trim()==='現金');if(fastEntryFirstOpen){selected=cash?.value||selected;fastEntryFirstOpen=false}if(!selected||![...$('#fast-account').options].some(x=>x.value===selected))selected=cash?.value||$('#fast-account').options[0]?.value;$('#fast-account').value=selected;if(type==='expense')$('#credit-account').value=selected;else $('#debit-account').value=selected;const data=await fetch('/api/categories?type='+type).then(r=>r.json()),items=[...data.favorites,...data.available],groups=[...new Set(items.map(x=>x.group_name||'其他'))];if(!groups.includes(fastEntryGroup))fastEntryGroup=type==='expense'&&groups.includes('生活飲食')?'生活飲食':groups[0]||'其他';$('#fast-group-select').innerHTML=groups.map(group=>`<option value="${escapeHtml(group)}" ${group===fastEntryGroup?'selected':''}>${escapeHtml(group)}</option>`).join('');$('#fast-major-tabs').innerHTML=groups.map(group=>`<button type="button" data-group="${escapeHtml(group)}" class="${group===fastEntryGroup?'':'secondary'}" style="width:auto;white-space:nowrap;padding:10px 14px;font-size:14px">${escapeHtml(group)}</button>`).join('');$('#fast-major-tabs').querySelectorAll('[data-group]').forEach(button=>button.addEventListener('click',()=>{fastEntryGroup=button.dataset.group;renderFastEntryCategories()}));const selectedCategory=type==='expense'?$('#debit-account').value:$('#credit-account').value,categories=items.filter(x=>(x.group_name||'其他')===fastEntryGroup);if(!categories.some(x=>x.id===selectedCategory)&&categories[0]){if(type==='expense')$('#debit-account').value=categories[0].id;else $('#credit-account').value=categories[0].id}const chosen=type==='expense'?$('#debit-account').value:$('#credit-account').value;$('#fast-category-grid').innerHTML=categories.map(x=>`<button type="button" data-fast-category="${x.id}" style="min-height:74px;padding:2px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;background:${x.id===chosen?'#e4f1ec':'#f5f6f4'};color:#17231f;border:${x.id===chosen?'3px solid #2684ff':'1px solid #e1e5e2'}"><span style="font-size:26px;line-height:1">${categoryIcon(x.name,x.icon)}</span><small style="font-size:.82rem;line-height:1.1">${escapeHtml(x.name)}</small></button>`).join('')||'<span class="muted" style="grid-column:1/-1">此大分類尚無小分類</span>';$('#fast-category-grid').querySelectorAll('[data-fast-category]').forEach(button=>button.addEventListener('click',()=>{if(type==='expense')$('#debit-account').value=button.dataset.fastCategory;else $('#credit-account').value=button.dataset.fastCategory;renderFastEntryCategories()}));updateFastAmount()}
function setupQuickCategories(){const section=document.createElement('section');section.id='quick-categories';section.style.cssText='margin:14px 0;border:1px solid #d9ded9;border-radius:16px;padding:12px;background:#fff';$('#simple-entry').before(section);$('#entry-type').addEventListener('change',()=>{categoryManageMode=false;loadQuickCategories()});$('#debit-account').addEventListener('change',()=>loadQuickCategories());$('#credit-account').addEventListener('change',()=>loadQuickCategories());setTimeout(()=>loadQuickCategories(),300)}

function setupCategoryManagerTree(){
  const bar=document.createElement('section');bar.style.cssText='margin:-4px 0 14px';
  const openButton=document.createElement('button');openButton.type='button';openButton.className='secondary';openButton.textContent='管理分類';bar.append(openButton);document.querySelector('main').insertBefore(bar,$('.view-tabs'));
  const dialog=document.createElement('dialog');dialog.id='category-manager-dialog';dialog.style.width='min(calc(100% - 20px),760px)';dialog.innerHTML='<div style="padding:20px"><div class="dialog-title"><h2 style="flex:1;text-align:center">管理分類／帳戶</h2><button type="button" class="icon-button" id="category-manager-close">×</button></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:7px"><button type="button" id="manage-expense">支出分類</button><button type="button" id="manage-income" class="secondary">收入分類</button></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:12px"><button type="button" id="manage-asset" class="secondary">資產帳戶</button><button type="button" id="manage-liability" class="secondary">負債帳戶</button></div><button type="button" id="manager-create" class="secondary" style="margin-bottom:12px">＋ 新增分類</button><div id="manager-list"></div></div>';document.body.append(dialog);
  const editor=document.createElement('dialog');editor.id='category-editor-dialog';editor.style.width='min(calc(100% - 24px),460px)';editor.innerHTML='<form id="category-editor-form" style="padding:20px"><div class="dialog-title"><h2 id="category-editor-title" style="flex:1;text-align:center">新增分類</h2><button type="button" class="icon-button" id="category-editor-close">×</button></div><label id="category-editor-name-label">分類名稱<input id="category-editor-name" maxlength="80" autocomplete="off" required></label><label id="category-editor-parent-label">隸屬大分類<select id="category-editor-parent"></select></label><p id="category-editor-error" class="error"></p><div class="form-actions"><button type="button" class="secondary" id="category-editor-cancel">取消</button><button type="submit">確定</button></div></form>';document.body.append(editor);
  const orderDialog=document.createElement('dialog');orderDialog.id='category-order-dialog';orderDialog.style.width='min(calc(100% - 24px),420px)';orderDialog.innerHTML='<div style="padding:20px"><div class="dialog-title"><h2 id="category-order-title" style="flex:1;text-align:center">排序小分類</h2><button type="button" class="icon-button" id="category-order-close">×</button></div><div id="category-order-list" style="display:grid;gap:8px"></div></div>';document.body.append(orderDialog);
  let manageType='expense',currentMajors=[],currentChildrenByMajor=new Map(),orderingMajor=null;
  const actions=x=>`<button type="button" class="secondary manager-rename" title="改名" aria-label="改名" data-id="${x.id}" data-name="${escapeHtml(x.name)}" style="width:40px;padding:7px">✎</button><button type="button" class="manager-delete" title="刪除" aria-label="刪除" data-id="${x.id}" data-name="${escapeHtml(x.name)}" data-usage="${x.usage_count}" style="width:40px;padding:7px;background:#a43d35">−</button>`;
  const child=x=>`<article style="position:relative;display:grid;grid-template-columns:1fr auto auto auto;gap:7px;align-items:center;padding:8px 0 8px 28px;border-bottom:1px solid #e4e8e5"><span style="position:relative"><i style="position:absolute;left:-20px;color:#8a9690;font-style:normal">└</i>${categoryIcon(x.name,x.icon)} <strong>${escapeHtml(x.name)}</strong>${x.usage_count?`<small style="display:block;color:#6d756f">${x.usage_count} 筆記錄</small>`:''}</span>${actions(x)}</article>`;
  const isBankAccount=()=>manageType==='asset'||manageType==='liability';
  function openEditor(){$('#category-editor-name').value='';$('#category-editor-parent').innerHTML='<option value="">其他分類（不隸屬大分類）</option>'+currentMajors.map(x=>`<option value="${escapeHtml(x.name)}">${escapeHtml(x.name)}</option>`).join('');$('#category-editor-parent').value='';$('#category-editor-error').textContent='';$('#category-editor-title').textContent=isBankAccount()?'新增帳戶':'新增分類';$('#category-editor-name-label').firstChild.textContent=isBankAccount()?'帳戶名稱':'分類名稱';$('#category-editor-parent-label').hidden=isBankAccount();editor.showModal();$('#category-editor-name').focus()}
  async function sync(){accounts=await fetch('/api/accounts').then(r=>r.json());configureEntryForm();loadQuickCategories()}
  function renderOrderDialog(){
    const items=currentChildrenByMajor.get(orderingMajor)||[];
    $('#category-order-title').textContent=`排序「${orderingMajor}」的小分類`;
    $('#category-order-list').innerHTML=items.map((item,i)=>`<div style="display:grid;grid-template-columns:1fr 44px 44px;gap:8px;align-items:center;padding:8px 12px;border:1px solid #d9ded9;border-radius:12px"><span>${escapeHtml(item.name)}</span><button type="button" class="secondary" data-order-up="${i}" ${i===0?'disabled':''} style="width:44px;height:44px;padding:0;font-size:18px">▲</button><button type="button" class="secondary" data-order-down="${i}" ${i===items.length-1?'disabled':''} style="width:44px;height:44px;padding:0;font-size:18px">▼</button></div>`).join('');
    $('#category-order-list').querySelectorAll('[data-order-up]').forEach(button=>button.addEventListener('click',()=>moveChild(Number(button.dataset.orderUp),-1)));
    $('#category-order-list').querySelectorAll('[data-order-down]').forEach(button=>button.addEventListener('click',()=>moveChild(Number(button.dataset.orderDown),1)));
  }
  async function moveChild(index,delta){
    const items=currentChildrenByMajor.get(orderingMajor)||[];
    const target=index+delta;
    if(target<0||target>=items.length)return;
    const ids=items.map(item=>item.id);
    [ids[index],ids[target]]=[ids[target],ids[index]];
    const response=await fetch('/api/categories/reorder',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({account_type:manageType,parent_name:orderingMajor,ids})});
    if(!response.ok){const result=await response.json().catch(()=>({}));alert(result.error||'排序儲存失敗');return}
    await refresh();
    renderOrderDialog();
  }
  function wireRowActions(){
    dialog.querySelectorAll('.manager-rename').forEach(button=>button.addEventListener('click',async event=>{event.stopPropagation();const name=prompt(isBankAccount()?'新的帳戶名稱':'新的分類名稱',button.dataset.name);if(!name||name===button.dataset.name)return;const response=await fetch('/api/categories/'+button.dataset.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})}),result=await response.json();if(!response.ok)return alert(result.error||'重新命名失敗');await sync();refresh()}));
    dialog.querySelectorAll('.manager-delete').forEach(button=>button.addEventListener('click',async event=>{event.stopPropagation();const usage=Number(button.dataset.usage),note=usage?`\n此${isBankAccount()?'帳戶':'分類'}已有 ${usage} 筆歷史分錄，舊帳仍會保留。`:'';if(!confirm(`確定刪除「${button.dataset.name}」？${note}`))return;const response=await fetch('/api/categories/'+button.dataset.id+'?mode=deactivate',{method:'DELETE'}),result=await response.json();if(!response.ok)return alert(result.error||'刪除失敗');await sync();refresh()}));
  }
  async function refresh(){
    if(isBankAccount()){
      const rows=await fetch('/api/bank-accounts?type='+manageType).then(r=>r.json());
      $('#manager-list').innerHTML=`<div style="font-size:20px;font-weight:800;margin:4px 0 10px">▼ ${manageType==='asset'?'資產':'負債'}</div>`+(rows.map(x=>`<article style="display:grid;grid-template-columns:1fr auto auto;gap:7px;align-items:center;padding:8px 0;border-bottom:1px solid #e4e8e5"><span>💰 <strong>${escapeHtml(x.name)}</strong>${x.usage_count?`<small style="display:block;color:#6d756f">${x.usage_count} 筆記錄</small>`:''}</span>${actions(x)}</article>`).join('')||'<p class="muted">尚無帳戶，按下面「＋ 新增帳戶」建立第一個</p>');
      wireRowActions();
      return;
    }
    const rows=await fetch('/api/category-management?type='+manageType).then(r=>r.json()),majors=rows.filter(x=>x.is_major),children=rows.filter(x=>!x.is_major),used=new Set();currentMajors=majors;
    currentChildrenByMajor=new Map();
    let html=`<div style="font-size:20px;font-weight:800;margin:4px 0 10px">▼ ${manageType==='expense'?'支出':'收入'}</div>`;
    for(const major of majors){const branch=children.filter(x=>x.parent_name===major.name);branch.forEach(x=>used.add(x.id));currentChildrenByMajor.set(major.name,branch);html+=`<section style="margin-left:12px;border-left:2px dotted #aab3ae;padding-left:12px"><div style="display:grid;grid-template-columns:auto 1fr auto auto auto;gap:7px;align-items:center;padding:9px 0"><button type="button" class="tree-toggle secondary" aria-expanded="true" style="width:32px;padding:5px">−</button><span style="font-size:18px">💰 <strong>${escapeHtml(major.name)}</strong></span><button type="button" class="secondary manager-reorder" data-major="${escapeHtml(major.name)}" title="排序小分類" aria-label="排序小分類" style="width:40px;padding:7px" ${branch.length<2?'disabled':''}>↕</button>${actions(major)}</div><div class="tree-children">${branch.map(child).join('')||'<small class="muted" style="display:block;padding:5px 0 10px 28px">尚無小分類</small>'}</div></section>`}
    const ungrouped=children.filter(x=>!used.has(x.id));if(ungrouped.length)html+=`<section style="margin:10px 0 0 12px;border-left:2px dotted #aab3ae;padding-left:12px"><div style="font-weight:800;padding:8px 0">▼ 其他分類</div>${ungrouped.map(child).join('')}</section>`;
    $('#manager-list').innerHTML=html;
    dialog.querySelectorAll('.tree-toggle').forEach(button=>button.addEventListener('click',()=>{const children=button.closest('section').querySelector('.tree-children'),open=!children.hidden;children.hidden=open;button.textContent=open?'＋':'−';button.setAttribute('aria-expanded',String(!open))}));
    dialog.querySelectorAll('.manager-reorder').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();orderingMajor=button.dataset.major;renderOrderDialog();orderDialog.showModal()}));
    wireRowActions();
  }
  openButton.addEventListener('click',()=>{dialog.showModal();refresh()});$('#category-manager-close').addEventListener('click',()=>dialog.close());
  $('#category-order-close').addEventListener('click',()=>orderDialog.close());
  const manageButtons={expense:$('#manage-expense'),income:$('#manage-income'),asset:$('#manage-asset'),liability:$('#manage-liability')};
  Object.entries(manageButtons).forEach(([type,button])=>button.addEventListener('click',()=>{manageType=type;Object.entries(manageButtons).forEach(([t,b])=>b.className=t===type?'':'secondary');$('#manager-create').textContent=isBankAccount()?'＋ 新增帳戶':'＋ 新增分類';refresh()}));
  $('#manager-create').addEventListener('click',()=>openEditor());$('#category-editor-close').addEventListener('click',()=>editor.close());$('#category-editor-cancel').addEventListener('click',()=>editor.close());
  $('#category-editor-form').addEventListener('submit',async event=>{event.preventDefault();const endpoint=isBankAccount()?'/api/accounts':'/api/categories',payload=isBankAccount()?{name:$('#category-editor-name').value,type:manageType}:{name:$('#category-editor-name').value,type:manageType,parent_name:$('#category-editor-parent').value||null};const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),result=await response.json();if(!response.ok){$('#category-editor-error').textContent=result.error||'儲存失敗';return}editor.close();await sync();refresh()});
}
function setupStockHoldings(){
  const bar=document.createElement('section');bar.style.cssText='margin:-4px 0 14px';
  const openButton=document.createElement('button');openButton.type='button';openButton.className='secondary';openButton.textContent='股票持股';bar.append(openButton);document.querySelector('main').insertBefore(bar,$('.view-tabs'));
  const dialog=document.createElement('dialog');dialog.id='stock-holdings-dialog';dialog.style.width='min(calc(100% - 20px),560px)';
  dialog.innerHTML='<div style="padding:20px"><div class="dialog-title"><h2 style="flex:1;text-align:center">股票持股</h2><button type="button" class="icon-button" id="stock-holdings-close">×</button></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:4px"><button type="button" id="stock-holding-create" class="secondary">＋ 新增持股</button><button type="button" id="stock-dividend-lookup" class="secondary">🔍 查詢股利</button></div><p id="stock-dividend-lookup-time" class="muted" style="margin:0 0 4px;font-size:12px"></p><p class="muted" style="margin:0 0 12px;font-size:12px">股利資料來源：cmoney.tw（非官方網站，僅供參考，實際金額請以銀行入帳為準）</p><div id="stock-holdings-list" style="display:grid;gap:8px"></div></div>';
  document.body.append(dialog);
  const editor=document.createElement('dialog');editor.id='stock-holding-editor-dialog';editor.style.width='min(calc(100% - 24px),400px)';
  editor.innerHTML='<form id="stock-holding-editor-form" style="padding:20px"><div class="dialog-title"><h2 id="stock-holding-editor-title" style="flex:1;text-align:center">新增持股</h2><button type="button" class="icon-button" id="stock-holding-editor-close">×</button></div><label>股票代號<input id="stock-holding-ticker" maxlength="20" autocomplete="off" required></label><p class="muted" style="margin:-10px 0 14px;font-size:12px">股票代號或名稱擇一輸入，另一個會自動帶出</p><label>股票名稱<input id="stock-holding-name" maxlength="80" autocomplete="off" required></label><label>股數<input id="stock-holding-quantity" type="number" min="1" step="1" inputmode="numeric" required></label><label>證券戶（選填）<input id="stock-holding-broker" maxlength="80" autocomplete="off"></label><p id="stock-holding-editor-error" class="error"></p><div class="form-actions"><button type="button" class="secondary" id="stock-holding-editor-cancel">取消</button><button type="submit">確定</button></div></form>';
  document.body.append(editor);
  let editingId=null,currentHoldings=[];
  // 點卡片本身直接進入修改，不用另外按「修改」按鈕；「刪除」移到卡片右下角，
  // 按鈕自己的 click 監聽器裡會 stopPropagation，避免點刪除同時誤觸修改。
  const rowActions=x=>`<div style="display:flex;justify-content:flex-end;margin-top:2px"><button type="button" class="stock-holding-delete" data-id="${x.id}" data-name="${escapeHtml(x.name)}" style="width:auto;padding:7px 14px;background:#a43d35">刪除</button></div>`;
  // 股利查詢結果直接併進同一張持股卡片裡（代號／股數／證券戶、最新股利／頻率／
  // 年殖利率、除息日／發放日都在同一個地方），不再是另外分開的一份清單——原本
  // 手機版是「持股清單」跟「股利查詢結果」兩份各自獨立的清單，跟桌面版原生
  // 視窗「一張表格一次看完所有欄位」的呈現方式不一致，比對起來很麻煩。不管是
  // 剛查完，還是打開視窗時從上次存的結果直接帶出來，都用同一個函式畫，畫面看
  // 起來一致（見 PROJECT_SPEC.md 13.69，跟桌面版「查過的股利資料要存起來，
  // 不用每次開視窗都重查」是同一個修法）。
  function renderDividendInfo(info){
    if(!info)return '<span class="muted" style="font-size:13px">尚未查詢股利</span>';
    if(info.error)return `<span class="error" style="font-size:13px">${escapeHtml(info.error)}</span>`;
    const yieldPercent=info.dividend_yield_percent!==null&&info.dividend_yield_percent!==undefined?`${info.dividend_yield_percent}%`:'—';
    return `<div class="muted" style="font-size:13px">${escapeHtml(info.frequency)}・年殖利率 ${yieldPercent}</div><div style="font-size:13px">最新股利 <b>${info.latest_amount}</b> 元／股（${escapeHtml(info.latest_period)}）</div><div class="muted" style="font-size:13px">除息日 ${info.ex_dividend_date||'—'}　發放日 ${info.payment_date||'—'}</div>`;
  }
  async function saveDividendLookup(holdingId,result){
    // 存起來給下次打開視窗直接顯示，不用每次都重新查一次；失敗就算了（頂多下次
    // 又要重查），不影響查詢本身已經在畫面上顯示的結果。
    try{await fetch('/api/stock-holdings/'+holdingId+'/dividend-lookup',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({result})})}catch(_){}
  }
  async function refresh(){
    const rows=await fetch('/api/stock-holdings').then(r=>r.json());
    currentHoldings=rows;
    $('#stock-holdings-list').innerHTML=rows.map(x=>`<article class="stock-holding-row" data-id="${x.id}" data-ticker="${escapeHtml(x.ticker)}" data-name="${escapeHtml(x.name)}" data-quantity="${x.quantity}" data-broker="${escapeHtml(x.broker_account||'')}" style="display:grid;gap:6px;padding:10px;border:1px solid #d9ded9;border-radius:12px;cursor:pointer"><span>📈 <strong>${escapeHtml(x.name)}</strong><small style="display:block;color:#6d756f">${escapeHtml(x.ticker)}・${x.quantity.toLocaleString()} 股${x.broker_account?'・'+escapeHtml(x.broker_account):''}</small></span><div id="dividend-row-${x.id}">${renderDividendInfo(x.dividend_lookup)}</div>${rowActions(x)}</article>`).join('')||'<p class="muted">尚無持股，按上面「＋ 新增持股」建立第一筆</p>';
    dialog.querySelectorAll('.stock-holding-row').forEach(article=>article.addEventListener('click',()=>{
      editingId=article.dataset.id;
      $('#stock-holding-editor-title').textContent='修改持股';
      $('#stock-holding-ticker').value=article.dataset.ticker;$('#stock-holding-ticker').disabled=true;
      $('#stock-holding-name').value=article.dataset.name;
      $('#stock-holding-quantity').value=article.dataset.quantity;
      $('#stock-holding-broker').value=article.dataset.broker;
      $('#stock-holding-editor-error').textContent='';
      editor.showModal();
    }));
    dialog.querySelectorAll('.stock-holding-delete').forEach(button=>button.addEventListener('click',async event=>{
      event.stopPropagation();
      if(!confirm(`確定刪除「${button.dataset.name}」這筆持股？`))return;
      const response=await fetch('/api/stock-holdings/'+button.dataset.id,{method:'DELETE'}),result=await response.json();
      if(!response.ok)return alert(result.error||'刪除失敗');
      refresh();
    }));
  }
  openButton.addEventListener('click',()=>{dialog.showModal();refresh()});
  $('#stock-holdings-close').addEventListener('click',()=>dialog.close());
  $('#stock-holding-create').addEventListener('click',()=>{
    editingId=null;
    $('#stock-holding-editor-title').textContent='新增持股';
    $('#stock-holding-ticker').value='';$('#stock-holding-ticker').disabled=false;
    $('#stock-holding-name').value='';$('#stock-holding-quantity').value='';$('#stock-holding-broker').value='';
    $('#stock-holding-editor-error').textContent='';
    editor.showModal();
  });
  // 只用手機、沒有電腦伺服器可以連的使用者（例如朋友純用 GitHub Pages 那份
  // 離線版本），本機的 /api/stock-dividend-lookup 一定會失敗（沒有伺服器可以
  // 幫忙繞過 cmoney.tw 的 CORS 限制，見 PROJECT_SPEC.md）。這裡改成先試本機
  // 路徑，失敗（沒有伺服器、或逾時）再改試 cloudflare/dividend-lookup-worker.js
  // 部署出來的公開代理服務——把同一套解析邏輯搬到 Cloudflare Worker（伺服器端
  // 程式，不受瀏覽器 CORS 限制）上執行，已實測跟桌面版查到的資料一致。
  const DIVIDEND_PROXY_FALLBACK_URL='https://dividend-lookup.kkljman.workers.dev';
  async function fetchDividendInfoForTicker(ticker){
    try{
      // 桌面伺服器查一檔股票最多卡 20 秒左右就會自己回傳逾時錯誤（見
      // dividend_lookup.py 的 curl --max-time 15／subprocess timeout=20），這裡
      // 加上 25 秒的用戶端逾時（比伺服器自己的上限多留一點緩衝）：手機訊號不好
      // 時連線可能整個卡住、既不成功也不失敗，沒有逾時的話 Promise 永遠不會
      // resolve 也不會 reject，會卡住整個查詢迴圈，後面的持股都不會再查。
      const response=await fetch('/api/stock-dividend-lookup?ticker='+encodeURIComponent(ticker),{signal:AbortSignal.timeout(25000)});
      const info=await response.json();
      if(response.ok&&!info.error)return info;
    }catch(_){/* 本機沒有伺服器可以查，改試下面的公開代理 */}
    const response=await fetch(DIVIDEND_PROXY_FALLBACK_URL+'?ticker='+encodeURIComponent(ticker),{signal:AbortSignal.timeout(25000)});
    const info=await response.json();
    if(!response.ok||info.error)throw new Error(info.error||'查詢失敗');
    return info;
  }
  $('#stock-dividend-lookup').addEventListener('click',async()=>{
    if(!currentHoldings.length)return;
    const button=$('#stock-dividend-lookup');button.disabled=true;
    for(const holding of currentHoldings){
      const el=document.getElementById('dividend-row-'+holding.id);
      if(!el)continue;
      el.innerHTML='<span class="muted" style="font-size:13px">查詢中…</span>';
      try{
        const info=await fetchDividendInfoForTicker(holding.ticker);
        el.innerHTML=renderDividendInfo(info);
        saveDividendLookup(holding.id,info);
      }catch(error){
        // 原本這裡不管實際拋出什麼例外都直接顯示同一句「查詢失敗」，把真正的
        // 原因（逾時？連線中斷？)吞掉了，之後要診斷同一個問題只能靠使用者
        // 截圖裡完全一樣的通用文字，看不出差異。改成把例外的名稱／訊息一起
        // 顯示出來，至少能分清楚是逾時（AbortError／TimeoutError）還是其他
        // 網路錯誤。
        const detail=error?.name==='AbortError'||error?.name==='TimeoutError'?'查詢逾時（25 秒內沒有回應）':(error?.message||String(error));
        const errorInfo={error:detail.startsWith('查詢失敗')?detail:`查詢失敗：${detail}`};
        el.innerHTML=renderDividendInfo(errorInfo);
        saveDividendLookup(holding.id,errorInfo);
      }
    }
    // 比照桌面版，查詢完成後在按鈕旁邊顯示這次查詢的日期時間，讓使用者知道
    // 目前看到的股利資料是什麼時候查的，不是每次打開視窗都重查（見 13.68 節）。
    const now=new Date();
    $('#stock-dividend-lookup-time').textContent=`查詢時間：${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    button.disabled=false;
  });
  $('#stock-holding-editor-close').addEventListener('click',()=>editor.close());
  $('#stock-holding-editor-cancel').addEventListener('click',()=>editor.close());
  $('#stock-holding-ticker').addEventListener('blur',async()=>{
    const ticker=$('#stock-holding-ticker').value.trim();
    if(!ticker||editingId||$('#stock-holding-name').value.trim())return;
    const result=await fetch('/api/stock-name-lookup?ticker='+encodeURIComponent(ticker)).then(r=>r.json()).catch(()=>({}));
    if(result.name)$('#stock-holding-name').value=result.name;
  });
  $('#stock-holding-name').addEventListener('blur',async()=>{
    const name=$('#stock-holding-name').value.trim();
    if(!name||editingId||$('#stock-holding-ticker').value.trim())return;
    const result=await fetch('/api/stock-ticker-lookup?name='+encodeURIComponent(name)).then(r=>r.json()).catch(()=>({}));
    if(result.ticker)$('#stock-holding-ticker').value=result.ticker;
  });
  $('#stock-holding-editor-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const name=$('#stock-holding-name').value,quantity=Number($('#stock-holding-quantity').value),broker_account=$('#stock-holding-broker').value.trim()||null;
    const response=editingId
      ?await fetch('/api/stock-holdings/'+editingId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,quantity,broker_account})})
      :await fetch('/api/stock-holdings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticker:$('#stock-holding-ticker').value,name,quantity,broker_account})});
    const result=await response.json();
    if(!response.ok){$('#stock-holding-editor-error').textContent=result.error||'儲存失敗';return}
    editor.close();refresh();
  });
}
function setupAnnualReport(){
const bar=document.createElement('section');bar.style.cssText='margin:-4px 0 14px';const openButton=document.createElement('button');openButton.type='button';openButton.textContent='年度收支統計';bar.append(openButton);document.querySelector('main').insertBefore(bar,$('.view-tabs'));
const dialog=document.createElement('dialog');dialog.id='annual-report-dialog';dialog.style.width='min(calc(100% - 20px),1000px)';
const monthOptions=Array.from({length:12},(_,i)=>i+1).map(m=>`<option value="${m}">${m} 月</option>`).join('');
dialog.innerHTML=`<div style="padding:20px"><div class="dialog-title"><h2>年度收支統計</h2><button type="button" class="icon-button" id="annual-close">×</button></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px"><select id="annual-year" style="text-align:center;text-align-last:center;font-weight:700"></select><select id="annual-month-select" style="text-align:center;text-align-last:center"><option value="0">整年</option>${monthOptions}</select></div><table style="width:100%;border-collapse:collapse"><thead id="annual-summary-head"></thead><tbody id="annual-summary"></tbody></table><div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:18px 0 10px"><button type="button" id="annual-expense">支出明細</button><button type="button" id="annual-income" class="secondary">收入明細</button></div><input type="search" id="annual-detail-search" placeholder="搜尋分類" style="width:100%;margin-bottom:10px"><h3 id="annual-detail-title"></h3><div id="annual-detail" class="category-report"></div></div>`;
document.body.append(dialog);
let selectedMonth=0,detailType='expense',currentReport=null,currentCategories=[],annualYearOptionsReady=false;
const cellStyle='padding:10px;border-bottom:1px solid #d9ded9;text-align:right;white-space:nowrap';
async function populateAnnualYearOptions(){
  const currentYear=new Date().getFullYear();
  let earliestYear=currentYear-10;
  try{
    const summary=await fetch('/api/summary').then(r=>r.json());
    if(summary.date_min)earliestYear=Math.min(earliestYear,Number(summary.date_min.slice(0,4)));
  }catch(_){}
  const options=[];
  for(let y=currentYear+1;y>=earliestYear;y--)options.push(`<option value="${y}">${y}</option>`);
  $('#annual-year').innerHTML=options.join('');
}
async function load(){
  const year=Number($('#annual-year').value);
  $('#annual-detail-search').value='';
  currentReport=await fetch(`/api/reports/annual?year=${year}&month=1&type=${detailType}`).then(r=>r.json());
  renderSummary();
  renderDetail();
}
function renderSummary(){
  const t=currentReport.totals;
  const row=selectedMonth===0?{label:'整年',income_minor:t.income_minor,expense_minor:t.expense_minor,net_minor:t.net_minor,expense_income_ratio:t.expense_income_ratio}:{label:String(selectedMonth).padStart(2,'0')+' 月',...currentReport.months.find(x=>x.month===selectedMonth)};
  const headStyle='padding:10px;border-bottom:2px solid #d9ded9;text-align:right;white-space:nowrap';
  $('#annual-summary-head').innerHTML=`<tr><th style="${headStyle};text-align:left"></th><th style="${headStyle}">${row.label}</th><th style="${headStyle}">月平均</th></tr>`;
  const metricRow=(label,periodValue,averageValue,color)=>`<tr><td style="${cellStyle};text-align:left;font-weight:700">${label}</td><td style="${cellStyle}${color?';color:'+color:''}">${periodValue}</td><td style="${cellStyle}">${averageValue}</td></tr>`;
  $('#annual-summary').innerHTML=
    metricRow('收入總額',money.format(row.income_minor),money.format(t.average_income_minor))+
    metricRow('支出總額',money.format(row.expense_minor),money.format(t.average_expense_minor))+
    metricRow('收支差額',money.format(row.net_minor),money.format(t.average_net_minor),row.net_minor<0?'#a63228':'#173f35')+
    metricRow('支出占收入',row.expense_income_ratio===null?'—':(row.expense_income_ratio*100).toFixed(2)+'%',t.active_months+' 個月');
}
function categoriesForSelection(){
  return currentReport.year_detail.categories.map(cat=>{
    if(selectedMonth===0)return{account_id:cat.account_id,name:cat.name,amount_minor:cat.amount_minor,transactions:cat.months.flatMap(m=>m.transactions)};
    const m=cat.months.find(x=>x.month===selectedMonth);
    return m?{account_id:cat.account_id,name:cat.name,amount_minor:m.amount_minor,transactions:m.transactions}:null;
  }).filter(Boolean);
}
function renderDetail(){
  const year=Number($('#annual-year').value);
  const periodLabel=selectedMonth===0?`${year} 年`:`${year} 年 ${selectedMonth} 月`;
  $('#annual-detail-title').textContent=`${periodLabel}${detailType==='expense'?'支出':'收入'}明細`;
  const q=$('#annual-detail-search').value.trim();
  currentCategories=categoriesForSelection().filter(c=>!q||c.name.includes(q)).sort((a,b)=>Math.abs(b.amount_minor)-Math.abs(a.amount_minor));
  $('#annual-detail').innerHTML=currentCategories.map(x=>`<article class="category-row ${detailType}" data-account-id="${x.account_id}"><div class="category-head" style="cursor:pointer"><span>${escapeHtml(x.name)}</span><strong>${money.format(x.amount_minor)}</strong></div><div class="category-transactions" id="annual-cat-${x.account_id}" hidden></div></article>`).join('')||'<p class="muted">尚無資料</p>';
  $('#annual-detail').querySelectorAll('[data-account-id]').forEach(el=>el.querySelector('.category-head').addEventListener('click',()=>toggleCategoryTransactions(el.dataset.accountId)));
}
function toggleCategoryTransactions(accountId){
  const cat=currentCategories.find(c=>c.account_id===accountId);
  if(!cat)return;
  const container=document.getElementById(`annual-cat-${accountId}`);
  if(!container.hidden){container.hidden=true;return}
  const rows=[...cat.transactions].sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:0);
  container.innerHTML=rows.map(t=>`<div class="category-transaction-row" data-id="${t.id}"><span>${escapeHtml(t.date)}${t.memo?'　'+escapeHtml(t.memo):''}</span><b>${money.format(Math.abs(t.amount_minor))}</b></div>`).join('')||'<p class="muted">尚無資料</p>';
  container.querySelectorAll('[data-id]').forEach(el=>el.addEventListener('click',()=>openDetail(el.dataset.id)));
  container.hidden=false;
}
openButton.addEventListener('click',async()=>{const [year]=$('#month').value.split('-').map(Number);if(!annualYearOptionsReady){await populateAnnualYearOptions();annualYearOptionsReady=true}$('#annual-year').value=year;selectedMonth=0;$('#annual-month-select').value='0';detailType='expense';$('#annual-expense').className='';$('#annual-income').className='secondary';dialog.showModal();load()});
$('#annual-close').addEventListener('click',()=>dialog.close());
$('#annual-year').addEventListener('change',load);
$('#annual-month-select').addEventListener('change',()=>{selectedMonth=Number($('#annual-month-select').value);renderSummary();renderDetail()});
$('#annual-detail-search').addEventListener('input',renderDetail);
$('#annual-expense').addEventListener('click',()=>{detailType='expense';$('#annual-expense').className='';$('#annual-income').className='secondary';load()});
$('#annual-income').addEventListener('click',()=>{detailType='income';$('#annual-income').className='';$('#annual-expense').className='secondary';load()});
}
async function loadQuickCategories(){const section=$('#quick-categories');if(!section)return;const type=$('#entry-type').value;if(type==='transfer'){section.hidden=true;return}section.hidden=false;const selected=type==='expense'?$('#debit-account').value:$('#credit-account').value;try{const data=await fetch('/api/categories?type='+type).then(r=>r.json());const cards=data.favorites.map(x=>`<button type="button" data-category="${x.id}" style="background:${x.id===selected?'#ffd061':'#f5f6f4'};color:#17231f;padding:10px 4px;min-height:72px"><span style="display:block;font-size:24px">${categoryIcon(x.name,x.icon)}</span><span>${escapeHtml(x.name)}</span>${categoryManageMode?'<b style="color:#a43d35"> ×</b>':''}</button>`).join('');section.innerHTML=`<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px"><strong>常用分類</strong><button id="manage-categories" type="button" class="secondary" style="width:auto;padding:8px 12px">${categoryManageMode?'完成':'管理'}</button></div><div id="category-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:7px">${cards||'<span class="muted">尚未設定常用分類</span>'}</div>${categoryManageMode?`<div style="display:grid;grid-template-columns:1fr auto;gap:7px;margin-top:10px"><select id="available-category"><option value="">選擇既有分類</option>${data.available.map(x=>`<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('')}</select><button id="add-existing-category" type="button" style="width:auto">加入</button><button id="create-category" type="button" class="secondary" style="grid-column:1/-1">＋ 新增分類</button></div>`:''}`;$('#manage-categories').addEventListener('click',()=>{categoryManageMode=!categoryManageMode;loadQuickCategories()});section.querySelectorAll('[data-category]').forEach(button=>button.addEventListener('click',async()=>{if(categoryManageMode){if(confirm(`從常用分類移除「${button.innerText.replace('×','').trim()}」？`)){await fetch('/api/categories/'+button.dataset.category,{method:'DELETE'});loadQuickCategories()}return}if(type==='expense')$('#debit-account').value=button.dataset.category;else $('#credit-account').value=button.dataset.category;loadQuickCategories()}));if(categoryManageMode){$('#add-existing-category').addEventListener('click',async()=>{const id=$('#available-category').value;if(!id)return;await fetch('/api/categories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account_id:id})});loadQuickCategories()});$('#create-category').addEventListener('click',async()=>{const name=prompt('新分類名稱');if(!name)return;const response=await fetch('/api/categories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,type})});const result=await response.json();if(!response.ok){alert(result.error||'新增失敗');return}accounts=await fetch('/api/accounts').then(r=>r.json());configureEntryForm();if(type==='expense')$('#debit-account').value=result.id;else $('#credit-account').value=result.id;loadQuickCategories()})}}catch(error){section.innerHTML='<span class="error">分類載入失敗</span>'}}
function currentMonth(){const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`}
async function loadSummary(){const m=await fetch('/api/reports/monthly?month='+encodeURIComponent($('#month').value)).then(r=>r.json());const netCls=m.net_minor>=0?'positive':'negative';$('#summary').innerHTML=[['本月支出',maskMoney(m.expense_minor),'metric','expense'],['本月收入',maskMoney(m.income_minor),'metric','income'],['收支差額',maskMoney(m.net_minor),`metric metric-net ${netCls}`,null]].map(([k,v,c,type])=>`<article class="${c}${type&&transactionTypeFilter===type?' metric-active':''}"${type?` data-metric-type="${type}" style="cursor:pointer"`:''}><strong>${v}</strong><span class="muted">${k}</span></article>`).join('');$('#summary').querySelectorAll('[data-metric-type]').forEach(el=>el.addEventListener('click',()=>{const type=el.dataset.metricType;transactionTypeFilter=transactionTypeFilter===type?null:type;$('#summary').querySelectorAll('[data-metric-type]').forEach(card=>card.classList.toggle('metric-active',card.dataset.metricType===transactionTypeFilter));loadReport();loadTransactions()}))}
function polishLedgerLayout(){const summary=$('#summary'),range=$('#range');summary.style.gridTemplateColumns='repeat(auto-fit,minmax(180px,1fr))';range.style.display='none'}
// 原本只要手指按下的起點在 `.transaction`（單筆交易列）上，就直接放棄整段
// 滑動判斷（tracking=false）——本意大概是怕跟點一下交易列開啟明細的動作衝突，
// 但「交易」分頁整個畫面幾乎滿滿都是 `.transaction`，等於這個分頁完全滑不動，
// 「帳戶餘額」「分類統計」用的是別的 class（`.balance-card`／`.category-row`），
// 沒有這個排除，才會滑得動（使用者實機回報過這個落差）。其實不需要這個排除：
// 底下 touchend 已經用「橫向位移要大於 40px、而且明顯比縱向位移大」這個門檻
// 判斷是不是真的在滑動月份，一般點擊（幾乎沒有位移）本來就不會超過這個門檻，
// 不會誤觸換月，拿掉這個排除只是讓「交易」分頁也能正常滑動，不會讓點擊誤判。
function setupMonthSwipe(){const area=document.querySelector('main');let sx=0,sy=0,tracking=false;area.addEventListener('touchstart',e=>{const t=e.touches[0];sx=t.clientX;sy=t.clientY;tracking=true},{passive:true});area.addEventListener('touchend',e=>{if(!tracking)return;tracking=false;const t=e.changedTouches[0],dx=t.clientX-sx,dy=t.clientY-sy;if(Math.abs(dx)>40&&Math.abs(dx)>Math.abs(dy)*1.5)changeMonthAnimated(dx>0?-1:1)},{passive:true})}
function changeMonthAnimated(delta){const view=document.querySelector('.view:not([hidden])');if(!view){changeMonth(delta);return}const outX=delta>0?-36:36;view.style.transition='transform .3s ease, opacity .3s ease';view.style.transform=`translateX(${outX}px)`;view.style.opacity='0';setTimeout(async()=>{await changeMonth(delta);const nextView=document.querySelector('.view:not([hidden])')||view;nextView.style.transition='none';nextView.style.transform=`translateX(${-outX}px)`;nextView.style.opacity='0';requestAnimationFrame(()=>requestAnimationFrame(()=>{nextView.style.transition='transform .38s ease, opacity .38s ease';nextView.style.transform='translateX(0)';nextView.style.opacity='1'}))},280)}
function setupScrollTop(){const btn=$('#scroll-top');window.addEventListener('scroll',()=>{btn.hidden=window.scrollY<300},{passive:true});btn.addEventListener('click',()=>window.scrollTo({top:0,behavior:'smooth'}))}
function setupPrivacyToggle(){const cb=$('#privacy-toggle'),KEY='accounting-privacy-mode';cb.checked=localStorage.getItem(KEY)==='1';cb.addEventListener('change',()=>{localStorage.setItem(KEY,cb.checked?'1':'0');Promise.all([loadSummary(),loadTransactions(),loadReport(),loadBalances()])})}
async function loadTransactions(){const p=new URLSearchParams({limit:'200',month:$('#month').value});if($('#search').value.trim())p.set('q',$('#search').value.trim());if(transactionTypeFilter)p.set('type',transactionTypeFilter);const rows=await fetch('/api/transactions?'+p).then(r=>r.json());$('#transactions').innerHTML=rows.map(x=>`<article class="transaction" data-id="${x.id}"><div><div class="date">${x.transaction_date}${x.currency&&x.currency!=='TWD'?`<span class="date-currency">${Number(x.foreign_amount).toLocaleString('zh-TW',{maximumFractionDigits:2})} ${escapeHtml(x.currency)}折合台幣</span>`:''}</div><div class="accounts">${escapeHtml(x.accounts)}</div></div><div class="amount">${maskMoney(x.debit_total_minor)}</div>${x.memo?`<div class="muted">${escapeHtml(x.memo)}</div>`:'<div></div>'}${x.status!=='normal'?`<span class="badge">${x.status}</span>`:'<span></span>'}</article>`).join('')||`<p class="muted">${transactionTypeFilter?`本月尚無${transactionTypeFilter==='income'?'收入':'支出'}交易`:'本月尚無交易'}</p>`}
async function loadReport(){const report=await fetch('/api/reports/monthly?month='+encodeURIComponent($('#month').value)).then(r=>r.json());const categories=transactionTypeFilter?report.categories.filter(x=>x.type===transactionTypeFilter):report.categories;const max=Math.max(1,...categories.map(x=>Math.abs(x.amount_minor)));$('#category-report').innerHTML=categories.sort((a,b)=>Math.abs(b.amount_minor)-Math.abs(a.amount_minor)).map(x=>`<article class="category-row ${x.type}" data-account-id="${x.account_id}"><div class="category-head" style="cursor:pointer"><span>${escapeHtml(x.name)}</span><strong>${maskMoney(x.amount_minor)}</strong></div><div class="bar"><span style="width:${Math.min(100,Math.abs(x.amount_minor)/max*100)}%"></span></div><div class="category-transactions" id="report-cat-${x.account_id}" hidden></div></article>`).join('')||`<p class="muted">本月尚無${transactionTypeFilter?transactionTypeFilter==='income'?'收入':'支出':'分類'}資料</p>`;$('#category-report').querySelectorAll('[data-account-id]').forEach(el=>el.querySelector('.category-head').addEventListener('click',()=>toggleReportCategoryTransactions(el.dataset.accountId)))}
async function toggleReportCategoryTransactions(accountId){const container=document.getElementById(`report-cat-${accountId}`);if(!container.hidden){container.hidden=true;return}const rows=await fetch('/api/transactions?limit=200&month='+encodeURIComponent($('#month').value)+'&account_id='+encodeURIComponent(accountId)).then(r=>r.json());container.innerHTML=rows.map(t=>`<div class="category-transaction-row" data-id="${t.id}"><span>${escapeHtml(t.transaction_date)}${t.memo?'　'+escapeHtml(t.memo):''}</span><b>${maskMoney(t.debit_total_minor)}</b></div>`).join('')||'<p class="muted">尚無資料</p>';container.querySelectorAll('[data-id]').forEach(el=>el.addEventListener('click',()=>openDetail(el.dataset.id)));container.hidden=false}
async function loadBalances(){const [year,month]=$('#month').value.split('-').map(Number);const through=new Date(year,month,0).toLocaleDateString('sv-SE');const rows=await fetch('/api/account-balances?through='+through).then(r=>r.json());$('#balances').innerHTML=rows.filter(x=>['asset','liability'].includes(x.account_type)&&x.active).map(x=>`<article class="balance-card"><span>${escapeHtml(x.name)}</span><strong>${maskMoney(x.balance_minor)}</strong></article>`).join('')||'<p class="muted">尚無帳戶資料</p>'}
function changeMonth(delta){const [y,m]=$('#month').value.split('-').map(Number);const d=new Date(y,m-1+delta,1);$('#month').value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;return Promise.all([loadSummary(),loadTransactions(),loadReport(),loadBalances()])}
function stepDateField(selector,delta){const input=$(selector);if(!input.value)return;const [y,m,d]=input.value.split('-').map(Number);const next=new Date(y,m-1,d+delta);input.value=`${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-${String(next.getDate()).padStart(2,'0')}`}
function accountOptions(types){return accounts.filter(a=>a.active&&types.includes(a.account_type)).map((account,index)=>({account,index})).sort((left,right)=>{const rank=name=>name==='現金'?-1:name==='房屋貸款'||name==='房屋貨款'?1:0;return rank(left.account.name)-rank(right.account.name)||left.index-right.index}).map(({account})=>`<option value="${account.id}">${escapeHtml(account.name)}</option>`).join('')}
function configureEntryForm(){const type=$('#entry-type').value;if(type==='expense'){$('#debit-label span').textContent='分類';$('#credit-label span').textContent='帳戶';$('#debit-account').innerHTML=accountOptions(['expense']);$('#credit-account').innerHTML=accountOptions(['asset','liability'])}else if(type==='income'){$('#debit-label span').textContent='收款帳戶';$('#credit-label span').textContent='收入分類';$('#debit-account').innerHTML=accountOptions(['asset']);$('#credit-account').innerHTML=accountOptions(['income'])}else{$('#debit-label span').textContent='轉入帳戶';$('#credit-label span').textContent='轉出帳戶';$('#debit-account').innerHTML=accountOptions(['asset','liability']);$('#credit-account').innerHTML=accountOptions(['asset','liability'])}const saved=JSON.parse(localStorage.getItem('last-entry-'+type)||'{}');if([...$('#debit-account').options].some(x=>x.value===saved.debit))$('#debit-account').value=saved.debit;if([...$('#credit-account').options].some(x=>x.value===saved.credit))$('#credit-account').value=saved.credit}
function readEntryRows(container){return [...container.querySelectorAll('.entry-row')].map(row=>{const amount=Number(row.querySelector('.entry-amount').value);const side=row.querySelector('.entry-side').value;return{account_id:row.querySelector('.entry-account').value,debit_minor:side==='debit'?amount:0,credit_minor:side==='credit'?amount:0}})}
function resetCreateForm(){$('#entry-form').reset();$('#entry-date').value=new Date().toLocaleDateString('sv-SE');$('#entry-type').value='expense';$('#entry-rate').value='1';splitMode=false;currentExchangeRate=null;fastEntryFirstOpen=true;fastEntryGroup='生活飲食';fastCalcStored=null;fastCalcOperator=null;$('#simple-entry').hidden=false;$('#split-entry').hidden=true;$('#toggle-split').textContent='切換為拆分交易';configureEntryForm();loadExchangeRate();renderFastEntryCategories();syncVisibleExchangeControls()}
function toggleSplit(){splitMode=!splitMode;if(splitMode){$('#entry-currency').value='TWD';loadExchangeRate()}$('#simple-entry').hidden=splitMode;$('#split-entry').hidden=!splitMode;$('#toggle-split').textContent=splitMode?'切換為一般交易':'切換為拆分交易';if(splitMode){const amount=Math.round(Number($('#entry-amount').value))||0;$('#create-entries').replaceChildren(entryRow({account_id:$('#debit-account').value,debit_minor:amount}),entryRow({account_id:$('#credit-account').value,credit_minor:amount}))}}
async function submitEntry(event){event.preventDefault();$('#form-error').textContent='';const currency=$('#entry-currency').value,foreignAmount=Number($('#entry-amount').value),rate=currency==='TWD'?1:Number($('#entry-rate').value);if(!(foreignAmount>0)||!(rate>0)){ $('#form-error').textContent=currency==='TWD'?'請輸入金額':'匯率尚未取得，請稍後再試';saveAndContinue=false;return}const amount=Math.round(foreignAmount*rate);const entries=splitMode?readEntryRows($('#create-entries')):[{account_id:$('#debit-account').value,debit_minor:amount},{account_id:$('#credit-account').value,credit_minor:amount}];const rateSnapshot=currentExchangeRate||manualRateSnapshot(currency,rate);const exchange=currency==='TWD'?null:{currency,foreign_amount:String(foreignAmount),twd_rate:String(rateSnapshot.twd_rate),rate_kind:rateSnapshot.rate_kind,source_name:rateSnapshot.source_name,source_url:rateSnapshot.source_url,quoted_at:rateSnapshot.quoted_at};const response=await fetch('/api/transactions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transaction_date:$('#entry-date').value,memo:$('#entry-memo').value,entries,exchange})});const result=await response.json();if(!response.ok){$('#form-error').textContent=result.error||'儲存失敗';saveAndContinue=false;return}if(!splitMode)localStorage.setItem('last-entry-'+$('#entry-type').value,JSON.stringify({debit:$('#debit-account').value,credit:$('#credit-account').value}));const keepOpen=saveAndContinue;saveAndContinue=false;if(!keepOpen)$('#entry-dialog').close();resetCreateForm();await Promise.all([loadSummary(),loadTransactions(),loadReport(),loadBalances()]);showToast('帳務已儲存');if(keepOpen)$('#entry-amount').focus()}
function entryRow(entry={account_id:'',debit_minor:0,credit_minor:0},locked=false){const side=entry.credit_minor?'credit':'debit';const amount=entry.credit_minor||entry.debit_minor||'';const row=document.createElement('div');row.className='entry-row';row.innerHTML=`<select class="entry-account" aria-label="帳戶" ${locked?'disabled':''}>${accounts.filter(a=>a.active||a.id===entry.account_id).map(a=>`<option value="${a.id}" ${a.id===entry.account_id?'selected':''}>${escapeHtml(a.name)}</option>`).join('')}</select><select class="entry-side" aria-label="借貸方向" ${locked?'disabled':''}><option value="debit" ${side==='debit'?'selected':''}>借方</option><option value="credit" ${side==='credit'?'selected':''}>貸方</option></select><input class="entry-amount" type="number" min="1" step="1" inputmode="numeric" value="${amount}" aria-label="金額" ${locked?'disabled':''}><button type="button" aria-label="刪除分錄" ${locked?'disabled':''}>×</button>`;row.querySelector('button').addEventListener('click',()=>row.remove());return row}
async function openDetail(id){const detail=await fetch('/api/transactions/'+id).then(r=>r.json());currentDetail=detail;$('#detail-id').value=detail.id;$('#detail-date').value=detail.transaction_date;$('#detail-memo').value=detail.memo||'';const debit=detail.entries.find(e=>e.debit_minor>0),credit=detail.entries.find(e=>e.credit_minor>0),category=detail.entries.find(e=>e.account_type==='expense')||detail.entries.find(e=>e.account_type==='income')||debit;detailCategorySide=category.credit_minor>0?'credit':'debit';const counterpart=detail.entries.find(e=>e.id!==category.id);detailCounterpartId=counterpart?.account_id||null;const categoryType=category.account_type,choices=accounts.filter(a=>a.active&&(categoryType==='expense'||categoryType==='income'?a.account_type===categoryType:true));$('#detail-category').innerHTML=choices.map(a=>`<option value="${a.id}" ${a.id===category.account_id?'selected':''}>${escapeHtml(a.name)}</option>`).join('');const exchange=detail.exchange;$('#detail-currency').value=exchange?.currency||'TWD';$('#detail-amount').value=exchange?.foreign_amount||detail.debit_total_minor;$('#detail-rate').value=exchange?.twd_rate||'1';detailRateSource=exchange;updateDetailConverted();$('#detail-date').disabled=false;$('#detail-memo').disabled=false;$('#save-detail').hidden=false;$('#detail-exchange').hidden=true;$('#detail-error').textContent='';$('#detail-dialog').showModal()}
async function saveDetail(event){event.preventDefault();$('#detail-error').textContent='';const foreignAmount=Number($('#detail-amount').value),rate=Number($('#detail-rate').value),currency=$('#detail-currency').value,amount=Math.round(foreignAmount*rate);if(!(foreignAmount>0)||!(rate>0)||!detailCounterpartId){$('#detail-error').textContent='請檢查金額、匯率與分類';return}const categoryId=$('#detail-category').value,entries=detailCategorySide==='debit'?[{account_id:categoryId,debit_minor:amount},{account_id:detailCounterpartId,credit_minor:amount}]:[{account_id:detailCounterpartId,debit_minor:amount},{account_id:categoryId,credit_minor:amount}],exchange=currency==='TWD'?null:{currency,foreign_amount:String(foreignAmount),twd_rate:String(rate),rate_kind:detailRateSource?.rate_kind||'manual',source_name:detailRateSource?.source_name||'手動輸入',source_url:detailRateSource?.source_url||'',quoted_at:detailRateSource?.quoted_at||null};const response=await fetch('/api/transactions/'+$('#detail-id').value,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({transaction_date:$('#detail-date').value,memo:$('#detail-memo').value,entries,exchange})});const result=await response.json();if(!response.ok){$('#detail-error').textContent=result.error||'儲存失敗';return}$('#detail-dialog').close();await Promise.all([loadSummary(),loadTransactions(),loadReport(),loadBalances()]);showToast('修改已儲存')}
async function voidDetail(){if(!confirm('確定要作廢這筆交易？作廢後不會列入帳目，但仍保留稽核紀錄。'))return;$('#detail-error').textContent='';const response=await fetch('/api/transactions/'+$('#detail-id').value,{method:'DELETE'});const result=await response.json();if(!response.ok){$('#detail-error').textContent=result.error||'作廢失敗';return}$('#detail-dialog').close();await Promise.all([loadSummary(),loadTransactions(),loadReport(),loadBalances()]);showToast('交易已作廢')}
function selectView(name){document.querySelectorAll('.view').forEach(view=>view.hidden=view.id!==name+'-view');document.querySelectorAll('.view-tabs button').forEach(button=>button.classList.toggle('active',button.dataset.view===name));if(name==='report')loadReport();if(name==='balances')loadBalances()}
async function initialize(){
// Service Worker 註冊/檢查更新故意放在這個函式最前面、搶在任何一步都還沒執行之前
// 就先跑：下面這一長串（讀帳戶、處理固定收支、載入報表…）只要中間任何一步丟出
// 例外，都會讓這個 async function 提早中斷、後面的敘述通通不會執行——如果 SW
// 註冊寫在最後面，使用者一旦不巧撞到某個資料相關的錯誤（例如某筆固定收支規則
// 指到的分類已經被刪除、實機發生過的真實案例），連「檢查有沒有新版本可以修好
// 這個錯誤」這件事都做不到，等於永久卡死在舊版、只能自己去手動清瀏覽器資料。
// 搬到最前面後，就算後面真的又出了什麼新問題，至少下一次部署的修正版本還是
// 能正常送達、使用者能自己恢復。
if('serviceWorker'in navigator){
  let refreshing=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(refreshing)return;
    refreshing=true;
    location.reload();
  });
  navigator.serviceWorker.register('/sw.js').then(registration=>{registration.update();document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')registration.update()})})
}
$('#month').value=currentMonth();$('#entry-date').value=new Date().toLocaleDateString('sv-SE');accounts=await fetch('/api/accounts').then(r=>r.json());configureEntryForm();await renderFastEntryCategories();await Promise.all([loadSummary(),loadTransactions()]);$('#previous').addEventListener('click',()=>changeMonthAnimated(-1));$('#next').addEventListener('click',()=>changeMonthAnimated(1));$('#entry-date-prev').addEventListener('click',()=>stepDateField('#entry-date',-1));$('#entry-date-next').addEventListener('click',()=>stepDateField('#entry-date',1));$('#detail-date-prev').addEventListener('click',()=>stepDateField('#detail-date',-1));$('#detail-date-next').addEventListener('click',()=>stepDateField('#detail-date',1));$('#entry-date').addEventListener('change',()=>{if(!$('#entry-date').value)$('#entry-date').value=new Date().toLocaleDateString('sv-SE')});$('#detail-date').addEventListener('change',()=>{if(!$('#detail-date').value)$('#detail-date').value=new Date().toLocaleDateString('sv-SE')});$('#month').addEventListener('change',()=>{if(!$('#month').value)$('#month').value=currentMonth();Promise.all([loadSummary(),loadTransactions(),loadReport(),loadBalances()])});let timer;$('#search').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(loadTransactions,250)});$('#add').addEventListener('click',()=>$('#entry-dialog').showModal());$('#close').addEventListener('click',()=>$('#entry-dialog').close());$('#entry-type').addEventListener('change',configureEntryForm);$('#entry-form').addEventListener('submit',submitEntry);$('#save-and-new').addEventListener('click',()=>{saveAndContinue=true;$('#entry-form').requestSubmit()});$('#toggle-split').addEventListener('click',toggleSplit);$('#add-create-entry').addEventListener('click',()=>$('#create-entries').append(entryRow()));$('#transactions').addEventListener('click',event=>{const card=event.target.closest('.transaction');if(card)openDetail(card.dataset.id)});$('#detail-close').addEventListener('click',()=>$('#detail-dialog').close());$('#add-entry').addEventListener('click',()=>$('#detail-entries').append(entryRow()));$('#detail-title-delete').addEventListener('click',voidDetail);$('#detail-form').addEventListener('submit',saveDetail);document.querySelectorAll('.view-tabs button').forEach(button=>button.addEventListener('click',()=>selectView(button.dataset.view)));}
function setupGroupedBalances(){const rowCard=row=>`<article class="balance-card"><span>${escapeHtml(row.name)}</span><strong>${maskMoney(row.balance_minor)}</strong></article>`;const groupedCard=(title,rows,kind)=>`<details class="balance-group ${kind}"><summary><span><strong>${escapeHtml(title)}</strong><small>${rows.length} 個帳戶・點擊查看</small></span><b>${maskMoney(rows.reduce((sum,row)=>sum+row.balance_minor,0))}</b></summary><div class="balance-group-items">${rows.map(rowCard).join('')}</div></details>`;loadBalances=async function(){const [year,month]=$('#month').value.split('-').map(Number),through=new Date(year,month,0).toLocaleDateString('sv-SE'),rows=(await fetch('/api/account-balances?through='+through).then(response=>response.json())).filter(row=>['asset','liability'].includes(row.account_type)&&row.active);const mortgage=rows.filter(row=>row.name==='房屋貸款'),bank=rows.filter(row=>row.name!=='房屋貸款'&&(row.parent_name==='銀行存款'||row.name==='銀行存款'||/(銀行|郵局).*(存款|帳戶)|^(土地銀行|台新銀行|玉山銀行|聯邦銀行)$/.test(row.name))),cards=rows.filter(row=>row.parent_name==='信用卡'||/信用卡/.test(row.name)),used=new Set([...bank,...cards,...mortgage].map(row=>row.id)),cash=rows.filter(row=>row.name==='現金'),others=rows.filter(row=>!used.has(row.id)&&row.name!=='現金');const content=[...cash.map(rowCard),bank.length>1?groupedCard('銀行存款',bank,'bank'):bank.map(rowCard).join(''),...others.map(rowCard),cards.length>1?groupedCard('信用卡',cards,'credit'):cards.map(rowCard).join(''),...mortgage.map(rowCard)].join('');$('#balances').innerHTML=content||'<p class="muted">尚無帳戶資料</p>'}}
function upgradeCloudScheduleSettings(){const form=$('#cloud-settings-form'),enabled=$('#cloud-backup-enabled'),time=$('#cloud-backup-time'),timeLabel=time.closest('label');enabled.parentElement.lastChild.textContent=' 啟用 Google Drive 自動加密備份';const schedule=document.createElement('section');schedule.id='cloud-schedule-options';schedule.innerHTML='<h4 style="margin:14px 0 8px">自動備份時間</h4><div style="display:grid;gap:10px"><label class="schedule-choice" style="grid-template-columns:auto 1fr;align-items:center;margin:0"><input type="radio" name="cloud-schedule-mode" value="interval" checked style="width:22px;height:22px"> 每隔一段時間</label><label id="cloud-interval-label">備份間隔<select id="cloud-backup-interval"><option value="1">每 1 小時</option><option value="2">每 2 小時</option><option value="3">每 3 小時</option><option value="4">每 4 小時</option><option value="6" selected>每 6 小時（建議）</option><option value="8">每 8 小時</option><option value="12">每 12 小時</option><option value="24">每 24 小時</option></select></label><label class="schedule-choice" style="grid-template-columns:auto 1fr;align-items:center;margin:0"><input type="radio" name="cloud-schedule-mode" value="daily" style="width:22px;height:22px"> 每日固定時間</label></div><p id="cloud-next-backup" class="muted" style="margin:10px 0 0"></p>';timeLabel.before(schedule);schedule.append(timeLabel);timeLabel.firstChild.textContent='每日備份時間';const mode=()=>form.querySelector('input[name="cloud-schedule-mode"]:checked').value;const refresh=()=>{const daily=mode()==='daily';timeLabel.hidden=!daily;$('#cloud-interval-label').hidden=daily;$('#cloud-next-backup').textContent=daily?`排程：每天 ${time.value||'03:00'} 備份`:`排程：每 ${$('#cloud-backup-interval').value} 小時備份一次`};schedule.addEventListener('change',refresh);time.addEventListener('input',refresh);form.addEventListener('submit',async event=>{event.preventDefault();event.stopImmediatePropagation();const response=await fetch('/api/cloud-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:enabled.checked,schedule_mode:mode(),interval_hours:Number($('#cloud-backup-interval').value),backup_time:time.value||'03:00'})}),result=await response.json();$('#cloud-settings-message').textContent=response.ok?'排程設定已儲存；完成 Google Drive 授權後會自動執行。':result.error||'儲存失敗';refresh()},true);refresh()}
function hideAnnualMenuExtras(){const rule=$('#main-menu-dialog .menu-profile-rule');if(rule)rule.style.display='none'}
function reorganizeMenuAndAppearance(){const exportMenu=$('#menu-export'),importMenu=$('#menu-import'),backupMenu=$('#menu-backup'),backupDialog=$('#cloud-settings-dialog');exportMenu.innerHTML='<span>↕</span>匯出／匯入';importMenu.style.display='none';backupMenu.innerHTML='<span>☁</span>帳務同步';backupDialog.querySelector('.dialog-title h2').textContent='帳務同步';$('#menu-recurring').after(backupMenu);backupMenu.after(exportMenu);const cloudForm=$('#cloud-settings-form'),transfer=document.createElement('dialog');transfer.id='transfer-dialog';transfer.innerHTML='<div class="utility-book"><div class="dialog-title"><div><p class="eyebrow dark">DATA TRANSFER</p><h2>匯出／匯入</h2></div><button type="button" class="icon-button" id="transfer-close">×</button></div><p class="notice">換手機前記得先匯出CSV檔到新手機</p><div class="utility-actions"><button type="button" id="transfer-export">匯出 CSV</button><button type="button" class="secondary" id="transfer-import">匯入 CSV</button></div><input id="transfer-file" type="file" accept=".csv,text/csv" hidden><p id="transfer-message" class="muted"></p></div>';document.body.append(transfer);const openBackup=async()=>{try{const values=await fetch('/api/cloud-settings').then(response=>response.json());$('#cloud-backup-enabled').checked=values.enabled;$('#cloud-backup-time').value=values.backup_time||'03:00';const radio=cloudForm.querySelector(`input[name="cloud-schedule-mode"][value="${values.schedule_mode||'interval'}"]`);if(radio)radio.checked=true;$('#cloud-backup-interval').value=String(values.interval_hours||6);cloudForm.dispatchEvent(new Event('change',{bubbles:true}))}catch(_){$('#cloud-settings-message').textContent='備份設定載入失敗'}$('#main-menu-dialog').close();backupDialog.showModal()};exportMenu.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();$('#main-menu-dialog').close();transfer.showModal()},true);backupMenu.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();openBackup()},true);$('#transfer-close').addEventListener('click',()=>transfer.close());$('#transfer-export').addEventListener('click',()=>location.href='/api/export');$('#transfer-import').addEventListener('click',()=>$('#transfer-file').click());$('#transfer-file').addEventListener('change',async()=>{const file=$('#transfer-file').files[0];if(!file)return;if(!confirm(`確定匯入 ${file.name}？`))return;$('#transfer-message').textContent='匯入中…';const response=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'text/csv','X-Filename':'import.csv'},body:file}),result=await response.json();if(!response.ok){$('#transfer-message').textContent=result.error||'匯入失敗';return}alert(`匯入完成：新增 ${result.imported_transactions} 筆，略過 ${result.skipped_transactions} 筆。`);location.reload()})}
setupDataTransfer();
setupAnnualReport();
setupCategoryManagerTree();
setupStockHoldings();
setupMainMenu();
hideAnnualMenuExtras();












setupCloudSettings();
upgradeCloudScheduleSettings();

function setupRecurringTransactions(){
  const actions=$('#main-menu-dialog .menu-actions'),button=document.createElement('button');
  button.type='button';button.id='menu-recurring';button.innerHTML='<span>🔁</span>固定收/支出';
  actions.insertBefore(button,$('#menu-export'));
  const dialog=document.createElement('dialog');dialog.id='recurring-dialog';
  dialog.innerHTML='<div style="padding:20px"><div class="dialog-title"><div><p class="eyebrow dark">RECURRING</p><h2>固定收/支出</h2></div><button type="button" class="icon-button" id="recurring-close">×</button></div><p class="notice">設定好之後，到了指定的日期就會自動記一筆帳，不用手動輸入。</p><button type="button" id="recurring-create" class="secondary" style="margin-bottom:12px">＋ 新增固定收支</button><div id="recurring-list"></div></div>';
  document.body.append(dialog);
  const editor=document.createElement('dialog');editor.id='recurring-editor-dialog';editor.style.width='min(calc(100% - 24px),460px)';
  editor.innerHTML='<form id="recurring-editor-form" style="padding:20px"><div class="dialog-title"><h2 id="recurring-editor-title">新增固定收支</h2><button type="button" class="icon-button" id="recurring-editor-close">×</button></div>'
    +'<label>名稱<input id="recurring-editor-name" maxlength="80" autocomplete="off" required></label>'
    +'<label>類型<select id="recurring-editor-type"><option value="expense">支出</option><option value="income">收入</option></select></label>'
    +'<label>大分類<div id="recurring-editor-major-tabs" style="display:flex;gap:6px;overflow-x:auto;padding-bottom:5px"></div></label>'
    +'<label>小分類<div id="recurring-editor-category-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px"></div></label>'
    +'<label>帳戶<select id="recurring-editor-account"></select></label>'
    +'<label>金額<input id="recurring-editor-amount" type="number" min="1" step="1" inputmode="numeric" required></label>'
    +'<p id="recurring-editor-dividend-hint" class="muted" style="margin:-10px 0 14px;font-size:12px">股利已計算二代健保及手續費，但仍以現實轉帳為准</p>'
    +'<label>頻率<div id="recurring-editor-frequency-buttons" style="display:flex;gap:8px;margin-top:2px">'
      +'<button type="button" class="secondary" data-frequency="yearly" style="width:auto;padding:9px 16px">每年</button>'
      +'<button type="button" class="secondary" data-frequency="monthly" style="width:auto;padding:9px 16px">每月</button>'
      +'<button type="button" class="secondary" data-frequency="irregular" style="width:auto;padding:9px 16px">股利</button>'
    +'</div></label>'
    +'<label id="recurring-editor-month-label">月份<select id="recurring-editor-month"></select></label>'
    +'<label id="recurring-editor-day-label">日期<select id="recurring-editor-day"></select></label>'
    +'<label id="recurring-editor-start-label">開始日期<input id="recurring-editor-start" type="date"></label>'
    +'<div id="recurring-editor-end-label" style="display:grid;gap:7px;margin:17px 0">'
      +'<span style="font-weight:650;font-size:14px">結束</span>'
      +'<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
        +'<span style="display:flex;align-items:center;gap:4px"><input type="radio" name="recurring-editor-end-mode" id="recurring-editor-end-continuous" checked><label for="recurring-editor-end-continuous">持續</label></span>'
        +'<span style="display:flex;align-items:center;gap:4px"><input type="radio" name="recurring-editor-end-mode" id="recurring-editor-end-specific"><label for="recurring-editor-end-specific">到</label></span>'
        +'<input id="recurring-editor-end" type="date" disabled style="flex:1;min-width:140px">'
      +'</div>'
    +'</div>'
    +'<label id="recurring-editor-irregular-label">發放日期<input id="recurring-editor-irregular-date" type="date"></label>'
    +'<p id="recurring-editor-error" class="error"></p>'
    +'<div class="form-actions"><button type="button" class="secondary" id="recurring-editor-cancel">取消</button><button type="submit">確定</button></div></form>';
  document.body.append(editor);
  $('#recurring-editor-day').innerHTML=Array.from({length:31},(_,i)=>i+1).map(day=>`<option value="${day}">${day} 日</option>`).join('');
  $('#recurring-editor-month').innerHTML=Array.from({length:12},(_,i)=>i+1).map(month=>`<option value="${month}">${month} 月</option>`).join('');
  let editingId=null,recurringEditorMajor=null,recurringEditorCategoryId=null,recurringEditorFrequency='monthly';
  // 「不固定」在資料庫層完全不是新的一種週期——底層還是存 frequency='yearly'，
  // 只是 start_date 跟 end_date 存成同一天，讓它剛好只觸發一次、之後不會每年
  // 重複，跟桌面版（PROJECT_SPEC.md 13.64／13.69）同一套做法，資料完全共用。
  const isIrregular=row=>Boolean(row.start_date&&row.end_date&&row.start_date===row.end_date);
  const frequencyLabel=row=>isIrregular(row)?'股利':(row.frequency==='monthly'?`每月 ${row.day_of_month} 日`:`每年 ${row.month_of_year} 月 ${row.day_of_month} 日`);
  // 分類選擇改成「大分類分頁＋小分類圖示方塊」，跟桌面版原生視窗的兩層選擇方式
  // 一致（也跟「新增交易」快速輸入畫面用的是同一套 group_name 分組資料），
  // 不再是單一個看不出圖示、把「大分類／小分類」硬塞成一行文字的下拉選單。
  async function refreshRecurringCategories(preserveSelection){
    const type=$('#recurring-editor-type').value;
    const data=await fetch('/api/categories?type='+type).then(r=>r.json());
    const items=[...data.favorites,...data.available];
    const groups=[...new Set(items.map(x=>x.group_name||'其他'))];
    if(!preserveSelection||!groups.includes(recurringEditorMajor))recurringEditorMajor=groups[0]||null;
    $('#recurring-editor-major-tabs').innerHTML=groups.map(group=>`<button type="button" data-group="${escapeHtml(group)}" class="${group===recurringEditorMajor?'':'secondary'}" style="width:auto;white-space:nowrap;padding:9px 14px;font-size:14px">${escapeHtml(group)}</button>`).join('');
    $('#recurring-editor-major-tabs').querySelectorAll('[data-group]').forEach(tabButton=>tabButton.addEventListener('click',()=>{recurringEditorMajor=tabButton.dataset.group;recurringEditorCategoryId=null;refreshRecurringCategories(true)}));
    const matching=items.filter(x=>(x.group_name||'其他')===recurringEditorMajor);
    if(!preserveSelection||!matching.some(x=>x.id===recurringEditorCategoryId))recurringEditorCategoryId=matching[0]?.id||null;
    $('#recurring-editor-category-grid').innerHTML=matching.map(x=>`<button type="button" data-category="${x.id}" style="min-height:70px;padding:2px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;background:${x.id===recurringEditorCategoryId?'#e4f1ec':'#f5f6f4'};color:#17231f;border:${x.id===recurringEditorCategoryId?'3px solid #2684ff':'1px solid #e1e5e2'}"><span style="font-size:24px;line-height:1">${categoryIcon(x.name,x.icon)}</span><small style="font-size:.78rem;line-height:1.1">${escapeHtml(x.name)}</small></button>`).join('')||'<span class="muted" style="grid-column:1/-1">此大分類尚無小分類</span>';
    $('#recurring-editor-category-grid').querySelectorAll('[data-category]').forEach(tileButton=>tileButton.addEventListener('click',()=>{recurringEditorCategoryId=tileButton.dataset.category;refreshRecurringCategories(true)}));
  }
  function refreshAccountOptions(){
    const rows=accounts.filter(row=>row.active&&['asset','liability'].includes(row.account_type));
    $('#recurring-editor-account').innerHTML=rows.map(row=>`<option value="${row.id}">${escapeHtml(row.name)}</option>`).join('');
    const cash=rows.find(row=>row.name==='現金');
    if(cash)$('#recurring-editor-account').value=cash.id;
  }
  // 頻率改成「每年／每月／不固定」三顆互斥按鈕，不是下拉選單，跟桌面版原生
  // 視窗的頻率選擇方式一致；選中的值存在 recurringEditorFrequency 這個變數裡
  // （不再有對應的 <select>），按鈕的作用只是切換樣式＋呼叫這個函式。
  function setFrequencyButtons(value){
    recurringEditorFrequency=value;
    $('#recurring-editor-frequency-buttons').querySelectorAll('[data-frequency]').forEach(freqButton=>{
      freqButton.className=freqButton.dataset.frequency===value?'':'secondary';
    });
    refreshFrequencyFields();
  }
  function refreshFrequencyFields(){
    const frequency=recurringEditorFrequency,isRecurring=frequency!=='irregular';
    $('#recurring-editor-month-label').hidden=frequency!=='yearly';
    $('#recurring-editor-day-label').hidden=!isRecurring;
    $('#recurring-editor-start-label').hidden=!isRecurring;
    $('#recurring-editor-end-label').hidden=!isRecurring;
    $('#recurring-editor-irregular-label').hidden=isRecurring;
    $('#recurring-editor-dividend-hint').hidden=isRecurring;
    $('#recurring-editor-day').required=isRecurring;
    $('#recurring-editor-start').required=isRecurring;
    $('#recurring-editor-irregular-date').required=!isRecurring;
  }
  async function openEditor(item=null){
    editingId=item?.id||null;
    $('#recurring-editor-title').textContent=item?'修改固定收支':'新增固定收支';
    $('#recurring-editor-name').value=item?.name||'';
    $('#recurring-editor-type').value=item?.account_type||'expense';
    refreshAccountOptions();
    if(item)$('#recurring-editor-account').value=item.counterpart_account_id;
    $('#recurring-editor-amount').value=item?String(item.amount_minor):'';
    recurringEditorCategoryId=item?.category_account_id||null;
    recurringEditorMajor=null;
    if(item){
      // 修改既有規則時，要先查出這筆分類屬於哪個大分類，分頁才能一開始就
      // 停在正確的大分類上，而不是每次都跳回第一個。
      const data=await fetch('/api/categories?type='+item.account_type).then(r=>r.json());
      const match=[...data.favorites,...data.available].find(x=>x.id===item.category_account_id);
      recurringEditorMajor=match?(match.group_name||'其他'):null;
    }
    await refreshRecurringCategories(true);
    setFrequencyButtons(item&&isIrregular(item)?'irregular':(item?.frequency||'monthly'));
    $('#recurring-editor-day').value=String(item?.day_of_month||1);
    $('#recurring-editor-month').value=String(item?.month_of_year||1);
    $('#recurring-editor-start').value=item?.start_date||new Date().toLocaleDateString('sv-SE');
    const hasEndDate=Boolean(item?.end_date);
    $('#recurring-editor-end-continuous').checked=!hasEndDate;
    $('#recurring-editor-end-specific').checked=hasEndDate;
    $('#recurring-editor-end').disabled=!hasEndDate;
    $('#recurring-editor-end').value=item?.end_date||'';
    $('#recurring-editor-irregular-date').value=item&&isIrregular(item)?item.start_date:'';
    $('#recurring-editor-error').textContent='';
    editor.showModal();
  }
  async function refresh(){
    const rows=await fetch('/api/recurring').then(response=>response.json());
    // 點項目本身直接進入修改，不用另外按「修改」按鈕；「刪除」移到卡片右下角，
    // 用 stopPropagation 擋掉冒泡，避免點刪除同時誤觸整張卡片的修改動作。
    $('#recurring-list').innerHTML=rows.map(row=>`<article class="category-row ${row.account_type}" data-recurring-edit="${row.id}" style="cursor:pointer"><div class="category-head"><span>${escapeHtml(row.name)}</span><strong>${money.format(row.amount_minor)}</strong></div><div class="muted">${row.account_type==='expense'?'支出':'收入'}・${escapeHtml(frequencyLabel(row))}・帳戶：${escapeHtml(row.counterpart_name)}${row.next_date?`・下次：${escapeHtml(row.next_date)}`:''}</div><div style="display:flex;justify-content:flex-end;margin-top:8px"><button type="button" data-recurring-delete="${row.id}" data-name="${escapeHtml(row.name)}" style="width:auto;padding:7px 14px;background:#a43d35">刪除</button></div></article>`).join('')||'<p class="muted">尚未設定固定收支</p>';
    $('#recurring-list').querySelectorAll('[data-recurring-edit]').forEach(el=>el.addEventListener('click',()=>openEditor(rows.find(row=>row.id===el.dataset.recurringEdit))));
    $('#recurring-list').querySelectorAll('[data-recurring-delete]').forEach(el=>el.addEventListener('click',async event=>{
      event.stopPropagation();
      if(!confirm(`確定刪除「${el.dataset.name}」這筆固定收支設定？已經產生的帳務不會被刪除。`))return;
      const response=await fetch('/api/recurring/'+el.dataset.recurringDelete,{method:'DELETE'}),result=await response.json();
      if(!response.ok)return alert(result.error||'刪除失敗');
      refresh();
    }));
  }
  button.addEventListener('click',()=>{$('#main-menu-dialog').close();dialog.showModal();refresh()});
  $('#recurring-close').addEventListener('click',()=>dialog.close());
  $('#recurring-create').addEventListener('click',()=>openEditor());
  $('#recurring-editor-close').addEventListener('click',()=>editor.close());
  $('#recurring-editor-cancel').addEventListener('click',()=>editor.close());
  $('#recurring-editor-type').addEventListener('change',()=>{recurringEditorCategoryId=null;recurringEditorMajor=null;refreshRecurringCategories(false)});
  $('#recurring-editor-frequency-buttons').querySelectorAll('[data-frequency]').forEach(freqButton=>freqButton.addEventListener('click',()=>setFrequencyButtons(freqButton.dataset.frequency)));
  $('#recurring-editor-end-continuous').addEventListener('change',()=>{$('#recurring-editor-end').disabled=true});
  $('#recurring-editor-end-specific').addEventListener('change',()=>{$('#recurring-editor-end').disabled=false});
  $('#recurring-editor-form').addEventListener('submit',async event=>{
    event.preventDefault();
    if(!recurringEditorCategoryId){$('#recurring-editor-error').textContent='請選擇小分類';return}
    const selectedFrequency=recurringEditorFrequency;
    let frequency,dayOfMonth,monthOfYear,startDate,endDate;
    if(selectedFrequency==='irregular'){
      const irregularDate=$('#recurring-editor-irregular-date').value;
      const [year,month,day]=irregularDate.split('-').map(Number);
      frequency='yearly';dayOfMonth=day;monthOfYear=month;startDate=irregularDate;endDate=irregularDate;
    }else{
      frequency=selectedFrequency;
      dayOfMonth=Number($('#recurring-editor-day').value);
      monthOfYear=frequency==='yearly'?Number($('#recurring-editor-month').value):null;
      startDate=$('#recurring-editor-start').value;
      endDate=$('#recurring-editor-end-specific').checked?($('#recurring-editor-end').value||null):null;
    }
    const payload={
      name:$('#recurring-editor-name').value,
      account_type:$('#recurring-editor-type').value,
      category_account_id:recurringEditorCategoryId,
      counterpart_account_id:$('#recurring-editor-account').value,
      amount_minor:Math.round(Number($('#recurring-editor-amount').value)),
      frequency,
      day_of_month:dayOfMonth,
      month_of_year:monthOfYear,
      start_date:startDate,
      end_date:endDate,
    };
    const url=editingId?'/api/recurring/'+editingId:'/api/recurring',method=editingId?'PUT':'POST';
    const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),result=await response.json();
    if(!response.ok){$('#recurring-editor-error').textContent=result.error||'儲存失敗';return}
    editor.close();
    refresh();
  });
}
setupRecurringTransactions();








reorganizeMenuAndAppearance();
function setupGoogleDriveBackupActions(){const connect=$('#google-connect'),status=$('#google-drive-status'),message=$('#cloud-settings-message'),test=document.createElement('button');test.type='button';test.id='google-backup-now';test.className='secondary';test.textContent='測試備份至 Google Drive';connect.after(test);const refresh=async()=>{const settings=await fetch('/api/cloud-settings').then(response=>response.json());status.textContent=settings.connected?'已連結 Google Drive':settings.configured?'尚未連結 Google Drive':'尚未設定 Google OAuth 憑證或加密金鑰';connect.textContent=settings.connected?'重新連結 Google 帳號':'連結 Google 帳號';test.hidden=!settings.connected;return settings};connect.addEventListener('click',async event=>{event.preventDefault();event.stopImmediatePropagation();const settings=await refresh();if(!settings.configured){message.textContent='請先設定 Google OAuth 用戶端資料、回呼網址及備份加密金鑰（本機模式可放在 data／ 目錄下，見 README）。';return}location.href='/api/google-drive/connect'},true);test.addEventListener('click',async()=>{test.disabled=true;test.textContent='加密並上傳中…';message.textContent='正在建立一致性備份、加密並上傳，請稍候。';try{const response=await fetch('/api/google-drive/backup',{method:'POST'}),result=await response.json();message.textContent=response.ok?`Google Drive 測試成功：${result.name}`:result.error||'Google Drive 備份失敗'}finally{test.disabled=false;test.textContent='測試備份至 Google Drive'}});$('#menu-backup').addEventListener('click',()=>setTimeout(()=>refresh().catch(()=>status.textContent='Google Drive 狀態讀取失敗'),0));if(new URLSearchParams(location.search).get('google')==='connected'){history.replaceState({},'',location.pathname);setTimeout(()=>showToast('Google Drive 已連結'),300)}}
setupGoogleDriveBackupActions();
function setupBackupConnectionStatusSync(){
  const dialog=$('#cloud-settings-dialog'),status=$('#google-drive-status'),connect=$('#google-connect'),test=$('#google-backup-now'),notice=dialog.querySelector('.notice p');
  const connectionRow=document.createElement('div');
  connectionRow.className='google-connection-row';
  connectionRow.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:16px;margin:10px 0';
  status.before(connectionRow);
  connectionRow.append(status,connect);
  status.style.cssText='margin:0;font-size:1.35rem;font-weight:800;color:var(--ink)';
  connect.style.cssText='width:auto;min-width:150px;margin:0;padding:12px 20px';
  const lastBackup=document.createElement('p');
  lastBackup.id='google-last-backup';
  lastBackup.className='muted';
  lastBackup.style.margin='10px 0 16px';
  test.after(lastBackup);
  const refresh=async()=>{
    const settings=await fetch('/api/cloud-settings',{cache:'no-store'}).then(response=>response.json());
    const label=settings.connected?'已連結':settings.configured?'尚未連結':'尚未設定 OAuth';
    status.textContent=label;
    connect.textContent=settings.connected?'重新連結':'連結';
    test.hidden=!settings.connected;
    notice.textContent=`狀態：${settings.connected?'已啟用並連結 Google Drive':settings.configured?'OAuth 已設定，尚未連結 Google Drive':'尚未啟用'}`;
    const history=await fetch('/api/backup-history',{cache:'no-store'}).then(response=>response.json());
    const latest=history.find(row=>String(row.id).startsWith('google-')&&row.status==='completed');
    lastBackup.textContent=latest?`最近 Google Drive 備份：${latest.completed_at||latest.started_at}`:'尚無 Google Drive 備份紀錄';
  };
  new MutationObserver(()=>{if(dialog.open)refresh().catch(()=>status.textContent='Google Drive 狀態讀取失敗')}).observe(dialog,{attributes:true,attributeFilter:['open']});
}
setupBackupConnectionStatusSync();
setupDialogBackButtons();
setupQuickCategories();
setupExchangeRate();
setupFastEntryUI();
function setupGroupOrdering(tabs,datasetKey,storageKey){
  if(!tabs)return;
  let arranging=false;
  const groupOf=button=>button.dataset[datasetKey];
  const groupButtons=()=>[...tabs.querySelectorAll('button')].filter(groupOf);
  const savedOrder=()=>{try{return JSON.parse(localStorage.getItem(storageKey)||'[]')}catch{return[]}};
  const persist=names=>localStorage.setItem(storageKey,JSON.stringify(names));
  const arrange=()=>{
    if(arranging)return;
    const buttons=groupButtons();
    if(!buttons.length)return;
    arranging=true;
    const saved=savedOrder(),index=name=>{const position=saved.indexOf(name);if(position>=0)return position;return name==='非常態性'?10000:5000+buttons.findIndex(button=>groupOf(button)===name)};
    const sorted=[...buttons].sort((a,b)=>index(groupOf(a))-index(groupOf(b)));
    if(sorted.some((button,i)=>button!==buttons[i]))sorted.forEach(button=>tabs.append(button));
    arranging=false;
  };
  new MutationObserver(arrange).observe(tabs,{childList:true});
  arrange();
  const sortButton=document.createElement('button');
  sortButton.type='button';sortButton.className='secondary';sortButton.setAttribute('aria-label','排序分類');sortButton.title='排序分類';
  sortButton.style.cssText='width:40px;height:40px;padding:0;font-size:19px;flex:none';
  sortButton.textContent='↕';
  tabs.after(sortButton);
  const orderDialog=document.createElement('dialog');
  orderDialog.style.width='min(calc(100% - 24px),420px)';
  document.body.append(orderDialog);
  function renderOrderDialog(){
    const names=groupButtons().map(groupOf);
    orderDialog.innerHTML=`<div style="padding:20px"><div class="dialog-title"><h2 style="flex:1;text-align:center">排序分類</h2><button type="button" class="icon-button" data-order-close>×</button></div><div data-order-list style="display:grid;gap:8px"></div></div>`;
    const list=orderDialog.querySelector('[data-order-list]');
    list.innerHTML=names.map((name,i)=>`<div style="display:grid;grid-template-columns:1fr 44px 44px;gap:8px;align-items:center;padding:8px 12px;border:1px solid #d9ded9;border-radius:12px"><span>${escapeHtml(name)}</span><button type="button" class="secondary" data-order-up="${i}" ${i===0?'disabled':''} style="width:44px;height:44px;padding:0;font-size:18px">▲</button><button type="button" class="secondary" data-order-down="${i}" ${i===names.length-1?'disabled':''} style="width:44px;height:44px;padding:0;font-size:18px">▼</button></div>`).join('');
    orderDialog.querySelector('[data-order-close]').addEventListener('click',()=>orderDialog.close());
    list.querySelectorAll('[data-order-up]').forEach(button=>button.addEventListener('click',()=>moveGroup(Number(button.dataset.orderUp),-1)));
    list.querySelectorAll('[data-order-down]').forEach(button=>button.addEventListener('click',()=>moveGroup(Number(button.dataset.orderDown),1)));
  }
  function moveGroup(index,delta){
    const names=groupButtons().map(groupOf);
    const target=index+delta;
    if(target<0||target>=names.length)return;
    [names[index],names[target]]=[names[target],names[index]];
    persist(names);
    arrange();
    renderOrderDialog();
  }
  sortButton.addEventListener('click',()=>{renderOrderDialog();orderDialog.showModal()});
}
setupGroupOrdering($('#fast-major-tabs'),'group','fast-major-group-order-v1');
setupSimplifiedDetail();
setupDetailFastUI();
setupGroupOrdering($('#detail-fast-tabs'),'detailGroup','fast-major-group-order-v1');
setupVisibleExchangeControls();
polishFastLayouts();
polishLedgerLayout();
setupMonthSwipe();
setupScrollTop();
setupPrivacyToggle();
setupGroupedBalances();
syncVisibleExchangeControls();
$('#detail-entries').style.display='none';
const openDetailOriginal=openDetail;
openDetail=async id=>{await openDetailOriginal(id);await renderDetailFastEditor(true);syncVisibleExchangeControls()};
$('.form-actions').style.display='none';
$('#search').placeholder='搜尋';
$('#search').setAttribute('aria-label','搜尋摘要、大分類或小分類');
$('#entry-form').addEventListener('submit',()=>{if(fastCalcStored!==null&&fastCalcOperator){const input=$('#entry-amount'),result=calculateFastAmount(Number(input.value)||0);input.value=String(Number(result.toFixed(6)));fastCalcStored=null;fastCalcOperator=null;updateFastAmount()}},true);
$('.flow-arrow')?.remove();
initialize().catch(error=>{
  // 原本這裡不管實際拋出什麼例外都只顯示同一句「載入失敗，請稍後重試」，
  // 把真正的原因整個吞掉——使用者在別的裝置上遇到「載入失敗」，只能拿到
  // 這句沒有任何線索的文字，沒辦法打開瀏覽器的開發者工具去看主控台，等於
  // 完全沒辦法回報是卡在哪裡。改成把例外訊息直接顯示在畫面上，讓使用者
  // 用截圖就能回報實際錯誤內容。
  console.error('初始化失敗',error);
  $('#transactions').innerHTML=`<p>載入失敗，請稍後重試。</p><p class="muted" style="font-size:12px;word-break:break-all">錯誤內容：${escapeHtml(String(error?.message||error))}</p>`;
});
