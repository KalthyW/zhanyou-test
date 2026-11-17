/* 八卦人格测试 · 数据埋点（独立脚本，不改原 HTML/CSS/JS）
 * 用法：放在 index.html 的 </body> 前，且必须在 config.js 之后。
 * 自建版：不依赖任何服务端，直接写 Supabase（见 supabase-schema.sql）。
 * 依赖：原页面的全局函数 startQuiz / renderQ / choose / renderTie / chooseTie /
 *       finishQuiz / toggleCheck / makeCard / relCta / sendBack / showRelation
 * 以及全局变量 qOrder / qi / scores / myType / selected / tieQueue / QUESTIONS / TYPES。
 */
(function () {
  "use strict";

  var API = window.BAGUA_API_BASE || "";

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  var anonKey = "bagua_anon_id";
  var anonId = localStorage.getItem(anonKey);
  if (!anonId) {
    anonId = uuid();
    try { localStorage.setItem(anonKey, anonId); } catch (e) {}
  }
  var sessionId = uuid();

  var params = new URLSearchParams(location.search);
  var incomingType = params.get("r");
  var returnType = params.get("me");

  var qStart = Date.now();
  var qShown = null;
  var isTie = false;
  var tieCount = 0;
  var calibTimer = null;

  var TABLES = {
    "/api/session": "quiz_sessions",
    "/api/event": "quiz_events",
    "/api/result": "quiz_results",
    "/api/calibration": "calibrations"
  };

  var TABLES = {
    "/api/session": "quiz_sessions",
    "/api/event": "quiz_events",
    "/api/result": "quiz_results",
    "/api/calibration": "calibrations"
  };

  // 两种后端任选其一：
  //  A) BAGUA_CONFIG.apiBase  → 走云函数（CloudBase 等），同域 /api/*
  //  B) BAGUA_CONFIG.url+key  → 直连 Supabase REST
  function post(path, data) {
    var cfg = window.BAGUA_CONFIG || {};
    var body = JSON.stringify(data);
    try {
      if (cfg.apiBase) {
        fetch(String(cfg.apiBase).replace(/\/+$/, "") + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body,
          keepalive: true
        }).catch(function () {});
        return;
      }
      var table = TABLES[path];
      if (!table || !cfg.url || !cfg.key) return;
      var row = {};
      for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) row[k] = data[k];
      row.created_at = new Date().toISOString();
      fetch(String(cfg.url).replace(/\/+$/, "") + "/rest/v1/" + table, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": cfg.key,
          "Authorization": "Bearer " + cfg.key,
          "Prefer": "return=minimal"
        },
        body: JSON.stringify(row),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  function track(event, payload) {
    post("/api/event", {
      session_id: sessionId,
      anon_id: anonId,
      event: event,
      test_id: (window.BAGUA_CONFIG && window.BAGUA_CONFIG.testId) || "bagua-v1",
      payload: payload || {},
      ts: Date.now()
    });
  }

  function wrap(name, before, after) {
    var orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function () {
      try { if (before) before.apply(this, arguments); } catch (e) {}
      var ret = orig.apply(this, arguments);
      try { if (after) after.apply(this, arguments); } catch (e) {}
      return ret;
    };
  }

  // 建立会话（后端没有这个接口也不影响事件，事件本身带 session_id/anon_id）
  post("/api/session", {
    session_id: sessionId,
    anon_id: anonId,
    source: document.referrer || "",
    user_agent: navigator.userAgent
  });

  if (incomingType && !returnType) {
    track("invite_open", { inviter_type: incomingType });
  }

  // 答题开始
  wrap("startQuiz", function () {
    tieCount = 0;
    isTie = false;
  }, function () {
    track("quiz_start", {});
  });

  // 每题展示时记录起点
  wrap("renderQ", function () {
    qStart = Date.now();
    qShown = qOrder[qi];
    isTie = false;
  }, null);

  // 普通题作答
  wrap("choose", function (opt) {
    var qid = qShown != null ? qShown : qOrder[qi];
    var q = QUESTIONS[qid];
    if (!q) return;
    var pick = opt === q.a ? "a" : "b";
    track("answer", {
      qid: qid,
      dim: q.dim,
      choice: pick,
      order: qi,
      ms: Date.now() - qStart
    });
  }, null);

  // 平局加试
  wrap("renderTie", function () {
    qStart = Date.now();
    isTie = true;
    tieCount++;
  }, null);

  wrap("chooseTie", function (opt) {
    var dim = tieQueue[0];
    var item = TIE[dim];
    if (!item) return;
    track("tie_answer", {
      dim: dim,
      choice: opt === item.a ? "a" : "b",
      ms: Date.now() - qStart
    });
  }, null);

  // 结果
  wrap("finishQuiz", null, function () {
    var type = myType;
    var name = TYPES[type] ? TYPES[type].name : "";
    var scoreCopy = {};
    Object.keys(scores).forEach(function (k) { scoreCopy[k] = scores[k]; });
    track("quiz_complete", {
      type_code: type,
      type_name: name,
      scores: scoreCopy,
      tie_count: tieCount
    });
    post("/api/result", {
      session_id: sessionId,
      anon_id: anonId,
      type_code: type,
      type_name: name,
      scores: scoreCopy,
      tie_count: tieCount
    });
  });

  // 校准勾选（防抖，最终落一次）
  wrap("toggleCheck", null, function () {
    clearTimeout(calibTimer);
    calibTimer = setTimeout(function () {
      var all = [0, 1, 2, 3, 4];
      var sel = selected.slice();
      var rejected = all.filter(function (i) { return sel.indexOf(i) === -1; });
      track("calib", {
        type_code: myType,
        selected: sel,
        rejected: rejected
      });
      post("/api/calibration", {
        session_id: sessionId,
        anon_id: anonId,
        type_code: myType,
        selected: sel,
        rejected: rejected
      });
    }, 600);
  });

  // 生成卡片
  wrap("makeCard", null, function () {
    track("card", {
      type_code: myType,
      selected: selected.slice()
    });
  });

  // 分享（无邀请参数时 relCta 打开分享弹窗；有邀请参数时 relCta 直接进关系页）
  wrap("relCta", null, function () {
    if (incomingType) return;
    setTimeout(function () {
      var modal = document.getElementById("m-share");
      if (!modal || !modal.classList.contains("on")) return;
      var link = document.getElementById("shareLink");
      track("share", {
        type_code: myType,
        link: link ? link.textContent : ""
      });
    }, 60);
  });

  // 把结果发回给 TA
  wrap("sendBack", null, function () {
    setTimeout(function () {
      var link = document.getElementById("shareLink");
      track("share_back", {
        type_code: myType,
        link: link ? link.textContent : ""
      });
    }, 60);
  });

  // 关系页生成（对方测完）
  wrap("showRelation", null, function (a, b) {
    var label = document.getElementById("relLabel");
    var hex = document.getElementById("relHex");
    var nameA = TYPES[a] ? TYPES[a].name : a;
    var nameB = TYPES[b] ? TYPES[b].name : b;
    track("invite_complete", {
      inviter_type: a,
      joiner_type: b,
      inviter_name: nameA,
      joiner_name: nameB,
      relation_label: label ? label.textContent : "",
      hexagram: hex ? hex.textContent : ""
    });
    post("/api/relationship", {
      session_id: sessionId,
      anon_id: anonId,
      inviter_type: a,
      joiner_type: b,
      relation_label: label ? label.textContent : "",
      hexagram: hex ? hex.textContent : ""
    });
  });

  // 回传链接直接进关系页时，原 init 已经执行，补记一次浏览
  setTimeout(function () {
    var active = document.querySelector(".screen.active");
    if (active && active.id === "s-rel") {
      var label = document.getElementById("relLabel");
      var types = document.getElementById("relTypes");
      track("relation_view", {
        label: label ? label.textContent : "",
        types: types ? types.textContent : ""
      });
    }
  }, 0);
})();
