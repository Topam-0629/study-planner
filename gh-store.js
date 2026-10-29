/* 공부 계획표 저장소: Firestore 비슷한 인터페이스를 GitHub 저장소(JSON 파일)에 연결한다.
   - 데이터는 사용자의 비공개 저장소 data/*.json 에 저장된다(토큰은 이 브라우저에만 저장).
   - window.claude.use("db" | "downloads") 형태를 흉내 내서 앱 코드를 거의 그대로 쓴다. */
(function(){
  "use strict";
  var LS="sp-gh-v1", FILES=["goals","plans","todos","sessions","backlog","config"];
  var DEFAULT_REPO="Topam-0629/study-planner-data";
  var cfg=readCfg();
  var state={}, meta={}, pending=[], listeners=[], flushing=false, again=false, flushT=0, pollT=0, retryT=0, ready=false;
  FILES.forEach(function(f){state[f]={};meta[f]={sha:null,etag:null}});

  function readCfg(){try{return JSON.parse(localStorage.getItem(LS)||"null")||{}}catch(e){return {}}}
  function saveCfg(){try{localStorage.setItem(LS,JSON.stringify(cfg))}catch(e){}}
  function $(s){return document.querySelector(s)}
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}

  /* ---------- base64 / UTF-8 ---------- */
  function b64enc(str){
    var bytes=new TextEncoder().encode(str),bin="",i,CH=0x8000;
    for(i=0;i<bytes.length;i+=CH)bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+CH));
    return btoa(bin);
  }
  function b64dec(b64){
    var bin=atob(b64.replace(/\s/g,"")),bytes=new Uint8Array(bin.length),i;
    for(i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---------- GitHub API ---------- */
  function hdr(extra){
    var h={"Authorization":"Bearer "+cfg.token,"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
    for(var k in (extra||{}))h[k]=extra[k];
    return h;
  }
  function url(name){return (cfg.api||"https://api.github.com")+"/repos/"+cfg.repo+"/contents/data/"+name+".json"}
  function apiErr(r,msg){var e=new Error(msg||("HTTP "+r.status));e.status=r.status;return e}
  /* name 파일 읽기. etag를 주면 바뀌지 않았을 때 {notModified:true} */
  function getFile(name,etag){
    var h=hdr(etag?{"If-None-Match":etag}:{});
    return fetch(url(name)+"?ref=main&t="+(etag?"":Date.now()),{headers:h,cache:"no-store"}).then(function(r){
      if(r.status===304)return {notModified:true};
      if(r.status===404)return {sha:null,data:{},etag:null};
      if(!r.ok)throw apiErr(r);
      var et=r.headers.get("ETag");
      return r.json().then(function(j){
        if(j.encoding==="base64"&&j.content)return {sha:j.sha,data:JSON.parse(b64dec(j.content)||"{}"),etag:et};
        return fetch(url(name)+"?ref=main",{headers:hdr({"Accept":"application/vnd.github.raw+json"}),cache:"no-store"}).then(function(r2){
          if(!r2.ok)throw apiErr(r2);return r2.text();
        }).then(function(t){return {sha:j.sha,data:JSON.parse(t||"{}"),etag:et}});
      });
    });
  }
  function putFile(name,obj,sha){
    var body={message:"update "+name,content:b64enc(JSON.stringify(obj)),branch:"main"};
    if(sha)body.sha=sha;
    return fetch(url(name),{method:"PUT",headers:hdr({"Content-Type":"application/json"}),body:JSON.stringify(body)}).then(function(r){
      if(r.status===409||r.status===422){var e=new Error("conflict");e.status=409;throw e}
      if(!r.ok)throw apiErr(r);
      return r.json();
    }).then(function(j){return j.content&&j.content.sha});
  }

  /* ---------- 로컬 상태·알림 ---------- */
  function applyOp(data,op){
    if(op.type==="delete"){delete data[op.id];return}
    if(op.type==="set"){data[op.id]=op.data;return}
    var cur=data[op.id]||{};for(var k in op.data)cur[k]=op.data[k];data[op.id]=cur;
  }
  function reapply(col){pending.forEach(function(op){if(op.col===col)applyOp(state[col],op)})}
  function notify(col){
    listeners.slice().forEach(function(l){
      if(l.col!==col)return;
      try{
        if(l.id===null){
          var docs=Object.keys(state[col]).map(function(id){var d=state[col][id];return {id:id,data:function(){return d}}});
          l.cb({docs:docs});
        }else{
          var d=state[col][l.id];l.cb({exists:!!d,id:l.id,data:function(){return d}});
        }
      }catch(e){if(window.console)console.error(e)}
    });
  }
  function notifyAll(){FILES.forEach(notify)}

  /* ---------- 상태 표시 ---------- */
  var badge;
  function setStatus(kind,text){
    if(!badge){
      badge=document.createElement("div");badge.id="gh-sync";
      badge.style.cssText="position:fixed;left:12px;bottom:12px;z-index:90;font:12px/1 var(--font,sans-serif);padding:7px 11px;border-radius:999px;background:var(--inv-bg,#111);color:var(--inv-fg,#fff);opacity:0;transition:opacity .25s;pointer-events:none";
      document.body.appendChild(badge);
    }
    clearTimeout(setStatus.t);
    badge.textContent=text;badge.style.opacity="1";
    if(kind==="ok")setStatus.t=setTimeout(function(){badge.style.opacity="0"},1400);
    if(kind==="error")badge.style.pointerEvents="auto",badge.onclick=function(){flush()};
    else badge.style.pointerEvents="none";
  }

  /* ---------- 쓰기(디바운스·충돌 재시도) ---------- */
  function schedule(){clearTimeout(flushT);flushT=setTimeout(flush,1200);setStatus("saving","저장 중…")}
  function flush(){
    clearTimeout(retryT);
    if(flushing){again=true;return}
    if(!pending.length){return}
    flushing=true;
    var ops=pending;pending=[];
    var cols=[];ops.forEach(function(o){if(cols.indexOf(o.col)<0)cols.push(o.col)});
    var p=Promise.resolve();
    cols.forEach(function(col){
      var mine=ops.filter(function(o){return o.col===col});
      p=p.then(function(){return writeCol(col,mine,0)});
    });
    p.then(function(){
      flushing=false;
      if(again||pending.length){again=false;flush()}else setStatus("ok","저장됨");
    },function(e){
      flushing=false;
      pending=ops.filter(function(o){return !o.done}).concat(pending);
      var why=e&&(e.status===401||e.status===403)?"토큰을 확인해 주세요":"저장 실패 · 다시 시도";
      setStatus("error",why+" (눌러서 재시도)");
      retryT=setTimeout(flush,20000);
    });
  }
  function writeCol(col,ops,n){
    return getFile(col).then(function(f){
      var data=f.data||{};
      ops.forEach(function(o){applyOp(data,o)});
      return putFile(col,data,f.sha).then(function(sha){
        ops.forEach(function(o){o.done=true});
        meta[col].sha=sha;meta[col].etag=null;
        state[col]=data;reapply(col);
      });
    }).catch(function(e){
      if(e&&e.status===409&&n<4)return writeCol(col,ops,n+1);
      throw e;
    });
  }

  /* ---------- 읽기·동기화 ---------- */
  function loadAll(){
    return Promise.all(FILES.map(function(f){return getFile(f).then(function(r){return [f,r]})})).then(function(rs){
      rs.forEach(function(x){var f=x[0],r=x[1];state[f]=r.data||{};meta[f]={sha:r.sha,etag:r.etag};reapply(f)});
    });
  }
  function poll(){
    if(!ready||document.hidden||flushing||pending.length)return;
    FILES.forEach(function(f){
      getFile(f,meta[f].etag).then(function(r){
        if(r.notModified||r.sha===meta[f].sha){if(r.etag)meta[f].etag=r.etag;return}
        if(flushing||pending.length)return;
        state[f]=r.data||{};meta[f]={sha:r.sha,etag:r.etag};reapply(f);notify(f);
      }).catch(function(){});
    });
  }

  /* ---------- Firestore 비슷한 db 객체 ---------- */
  function splitPath(p){var i=p.indexOf("/");return [p.slice(0,i),p.slice(i+1)]}
  function newId(col){return (col[0]||"x")+Date.now().toString(36)+Math.random().toString(36).slice(2,6)}
  function push(col,id,type,data){
    var op={col:col,id:id,type:type,data:data};
    applyOp(state[col],op);pending.push(op);notify(col);schedule();
    return Promise.resolve();
  }
  var db={
    collection:function(col){
      return {
        onSnapshot:function(cb,err){
          var l={col:col,id:null,cb:cb};listeners.push(l);
          setTimeout(function(){try{notify(col)}catch(e){}},0);
          return function(){listeners=listeners.filter(function(x){return x!==l})};
        },
        add:function(data){var id=newId(col);return push(col,id,"set",data).then(function(){return {id:id}})}
      };
    },
    doc:function(path){
      var p=splitPath(path),col=p[0],id=p[1];
      if(!state[col])state[col]={};
      return {
        onSnapshot:function(cb,err){
          var l={col:col,id:id,cb:cb};listeners.push(l);
          setTimeout(function(){try{notify(col)}catch(e){}},0);
          return function(){listeners=listeners.filter(function(x){return x!==l})};
        },
        set:function(data){return push(col,id,"set",data)},
        update:function(data){return push(col,id,"update",data)},
        delete:function(){return push(col,id,"delete")}
      };
    }
  };

  /* ---------- 다운로드 ---------- */
  var downloads={save:function(o){
    var blob=(o.data instanceof Blob)?o.data:new Blob([o.data],{type:o.mime||"application/json"});
    var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=o.filename||"download";
    document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},500);
    return Promise.resolve();
  }};

  /* ---------- 연결 화면 ---------- */
  function setupUI(msg){
    return new Promise(function(resolve){
      var old=$("#gh-setup");if(old)old.remove();
      var el=document.createElement("div");el.id="gh-setup";
      el.style.cssText="position:fixed;inset:0;z-index:200;background:var(--bg,#0a0a0a);color:var(--fg,#f2f2f2);overflow:auto;font-family:var(--font,sans-serif);padding:max(24px,env(safe-area-inset-top)) 20px 40px";
      el.innerHTML='<div style="max-width:520px;margin:0 auto">'+
        '<h1 style="font-size:26px;font-weight:500;margin:24px 0 8px">저장소 연결</h1>'+
        '<p style="color:var(--mute,#9b9b9b);line-height:1.6;margin:0 0 20px">계획과 기록은 내 GitHub 비공개 저장소에 저장돼요. 이 기기에서 처음 한 번만 설정하면 돼요.</p>'+
        (msg?'<p style="color:var(--bad,#ff6369);margin:0 0 14px">'+esc(msg)+'</p>':'')+
        '<label style="display:block;font-size:13px;color:var(--mute,#9b9b9b);margin:14px 0 6px">저장소</label>'+
        '<input id="gh-repo" value="'+esc(cfg.repo||DEFAULT_REPO)+'" autocomplete="off" style="width:100%;box-sizing:border-box;height:46px;border-radius:12px;border:1.5px solid var(--line,#262626);background:var(--soft,#161616);color:inherit;padding:0 14px;font-size:16px">'+
        '<label style="display:block;font-size:13px;color:var(--mute,#9b9b9b);margin:14px 0 6px">토큰 (Fine-grained personal access token)</label>'+
        '<input id="gh-token" type="password" value="" placeholder="github_pat_…" autocomplete="off" style="width:100%;box-sizing:border-box;height:46px;border-radius:12px;border:1.5px solid var(--line,#262626);background:var(--soft,#161616);color:inherit;padding:0 14px;font-size:16px">'+
        '<button id="gh-go" style="margin-top:18px;width:100%;height:50px;border-radius:25px;background:var(--inv-bg,#f2f2f2);color:var(--inv-fg,#0a0a0a);font-size:17px;font-weight:500;border:0;font-family:inherit;display:block;text-align:center">연결</button>'+
        '<details style="margin-top:22px;color:var(--mute,#9b9b9b);line-height:1.7"><summary style="cursor:pointer;color:var(--fg,#f2f2f2)">토큰은 어떻게 만들어요?</summary>'+
        '<ol style="padding-left:20px;margin:10px 0 0"><li>GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token</li>'+
        '<li>Repository access: Only select repositories → <b>study-planner-data</b> 하나만 선택</li>'+
        '<li>Permissions → Repository permissions → <b>Contents: Read and write</b></li>'+
        '<li>만든 토큰을 위 칸에 붙여넣기 (이 기기 브라우저에만 저장돼요)</li></ol></details>'+
        '</div>';
      document.body.appendChild(el);
      $("#gh-go").onclick=function(){
        var repo=$("#gh-repo").value.trim(),tok=$("#gh-token").value.trim();
        if(!repo||!tok){setupUI("저장소와 토큰을 모두 입력해 주세요").then(resolve);return}
        $("#gh-go").textContent="연결 중…";$("#gh-go").disabled=true;
        cfg={repo:repo,token:tok};
        loadAll().then(function(){saveCfg();el.remove();resolve(true)},function(e){
          cfg={};
          setupUI(e&&(e.status===401||e.status===403)?"토큰이 맞지 않거나 권한이 부족해요":e&&e.status===404?"저장소를 찾을 수 없어요 (이름·권한 확인)":"연결하지 못했어요. 네트워크를 확인해 주세요").then(resolve);
        });
      };
    });
  }

  function connect(){
    if(cfg.token&&cfg.repo){
      return loadAll().then(function(){return true},function(e){
        if(e&&(e.status===401||e.status===403||e.status===404))return setupUI("저장소에 접근하지 못했어요. 토큰을 다시 넣어 주세요");
        return false; /* 네트워크 문제: 오프라인 사본으로 */
      });
    }
    return setupUI("");
  }

  var dbPromise;
  window.claude={use:function(name){
    if(name==="downloads")return Promise.resolve(downloads);
    if(name!=="db")return Promise.resolve(null);
    if(!dbPromise)dbPromise=connect().then(function(ok){
      if(!ok)return null;
      ready=true;
      pollT=setInterval(poll,25000);
      document.addEventListener("visibilitychange",function(){if(!document.hidden)poll()});
      window.addEventListener("online",function(){flush();poll()});
      window.addEventListener("beforeunload",function(){if(pending.length||flushing){try{flush()}catch(e){}}});
      return db;
    });
    return dbPromise;
  }};
  window.spGhSetup=function(){setupUI("").then(function(){location.reload()})};
  document.addEventListener("click",function(e){var t=e.target.closest&&e.target.closest('[data-act="gh-setup"]');if(t){e.preventDefault();e.stopPropagation();window.spGhSetup()}},true);
  if("serviceWorker" in navigator&&(location.protocol==="https:"||location.hostname==="localhost")){
    navigator.serviceWorker.register("sw.js").catch(function(){});
  }
})();
