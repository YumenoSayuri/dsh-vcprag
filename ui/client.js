// @local/dsh-vcprag — client half
//
// 单个 bundle 文件。DSH 的 dsh.client 只认 platform / immediately / inject /
// external，bundle 入口固定是 package.json exports 的 "./client"；dsh.client.files
// 不是有效键，写在那里不会让额外脚本被加载。所以四个 Tab 必须全部内联在本文件里。
//
// 挂载点：settings.section（设置 → 插件 → 记忆召回）。
// 必须通过 ctx.slots.inject(...) 包 ctx.slots.register(...)，否则 DSH 根本不知道
// 有这么一个面板 —— 只 exports 组件是没用的。

window.__ModuleLoader__.load({
  id: '@local/dsh-vcprag',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var API = 'api/vcprag'
    /** 解析成绝对 URL：页面挂在子路径下时也不会打到错误的 origin 根。 */
    var endpoint = (suffix, params) => {
      var qs = ''
      if (params) {
        var parts = []
        for (var key in params) {
          var value = params[key]
          if (value === undefined || value === null || value === '') continue
          parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value))
        }
        if (parts.length > 0) qs = '?' + parts.join('&')
      }
      return new URL(API + suffix + qs, document.baseURI).href
    }

    function get(suffix, params) {
      return fetch(endpoint(suffix, params))
        .then(function (r) { return r.json() })
        .catch(function (e) { return { ok: false, error: String(e && e.message ? e.message : e) } })
    }

    function post(suffix, body) {
      return fetch(endpoint(suffix), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then(function (r) { return r.json() })
        .catch(function (e) { return { ok: false, error: String(e && e.message ? e.message : e) } })
    }

    // 只使用宿主主题 token，不写字面色值，浅色/深色都跟着走。
    var TOKEN = {
      label: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surface2: 'var(--dsw-alias-bg-layer-2)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))',
      mono: 'var(--dsw-alias-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    }

    var TONE = {
      ok: { bg: 'rgba(46, 160, 67, 0.16)', fg: TOKEN.success },
      warn: { bg: 'rgba(210, 153, 34, 0.18)', fg: 'var(--dsw-alias-state-warning-primary, #d29922)' },
      err: { bg: 'rgba(248, 81, 73, 0.16)', fg: TOKEN.error },
      info: { bg: 'rgba(56, 139, 253, 0.16)', fg: TOKEN.brand },
      muted: { bg: 'var(--dsw-alias-bg-layer-2)', fg: TOKEN.label2 },
    }

    var S = {
      page: { padding: '18px 24px 40px', fontSize: 13, color: TOKEN.label, boxSizing: 'border-box', lineHeight: '20px' },
      tabs: { display: 'flex', gap: 2, borderBottom: '0.5px solid ' + TOKEN.border, marginBottom: 16 },
      tab: function (active) {
        return {
          font: 'inherit',
          fontSize: 13,
          padding: '8px 14px',
          cursor: 'pointer',
          background: 'transparent',
          border: 'none',
          borderBottom: active ? '2px solid ' + TOKEN.brand : '2px solid transparent',
          color: active ? TOKEN.label : TOKEN.label2,
          fontWeight: active ? 600 : 400,
        }
      },
      row: { display: 'flex', gap: 16, alignItems: 'flex-start' },
      col: { flex: 1, minWidth: 0 },
      card: {
        background: TOKEN.surface,
        border: '0.5px solid ' + TOKEN.border,
        borderRadius: 8,
        padding: 14,
        marginBottom: 12,
      },
      label: { display: 'block', fontSize: 12, color: TOKEN.label2, marginBottom: 4 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 9px',
        background: TOKEN.surface2,
        color: TOKEN.label,
        border: '0.5px solid ' + TOKEN.border2,
        borderRadius: 6,
        fontSize: 13,
        fontFamily: 'inherit',
        lineHeight: '18px',
      },
      button: function (primary) {
        return {
          font: 'inherit',
          fontSize: 13,
          lineHeight: '18px',
          padding: '6px 13px',
          cursor: 'pointer',
          borderRadius: 8,
          background: primary ? TOKEN.brand : 'transparent',
          color: primary ? TOKEN.label : TOKEN.label2,
          border: primary ? 'none' : '0.5px solid ' + TOKEN.border2,
        }
      },
      badge: function (tone) {
        var t = TONE[tone] || TONE.muted
        return {
          display: 'inline-block',
          padding: '1px 7px',
          borderRadius: 4,
          fontSize: 11,
          lineHeight: '16px',
          background: t.bg,
          color: t.fg,
          marginRight: 6,
          marginBottom: 3,
        }
      },
      mono: { fontFamily: TOKEN.mono, fontSize: 12, lineHeight: '18px', color: TOKEN.label2 },
      listItem: function (active) {
        return {
          padding: '7px 10px',
          cursor: 'pointer',
          borderRadius: 6,
          background: active ? TOKEN.surface2 : 'transparent',
          color: TOKEN.label,
          marginBottom: 2,
        }
      },
      pre: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: TOKEN.mono, fontSize: 12, lineHeight: '18px', margin: 0 },
      hint: { fontSize: 11, color: TOKEN.label2, marginTop: 4, lineHeight: '17px' },
      // 行内代码：块标记这类东西要跟正文区分开，否则读者分不清哪段是要照抄的
      code: {
        fontFamily: TOKEN.mono,
        fontSize: 11,
        padding: '1px 4px',
        borderRadius: 3,
        background: TOKEN.surface2,
        color: TOKEN.label,
      },
      divider: { height: 1, background: TOKEN.border, margin: '12px 0' },
    }

    /** 通用确认弹窗（覆盖层）。 */
    function ConfirmDialog(props) {
      var overlay = {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }
      var box = {
        width: 560,
        maxWidth: '90vw',
        background: TOKEN.surface,
        border: '0.5px solid ' + TOKEN.error,
        borderRadius: 10,
        padding: 20,
        boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
        color: TOKEN.label,
      }
      return h('div', { style: overlay },
        h('div', { style: box },
          h('div', { style: { fontSize: 15, fontWeight: 700, marginBottom: 12, color: TOKEN.error } },
            props.title),
          h('div', { style: { fontSize: 13, lineHeight: '21px', marginBottom: 12, whiteSpace: 'pre-wrap' } },
            props.message),
          props.consequences && props.consequences.length > 0
            ? h('div', {
              style: {
                background: TOKEN.surface2,
                borderRadius: 6,
                padding: 10,
                marginBottom: 14,
                fontSize: 12,
                lineHeight: '21px',
                fontFamily: TOKEN.mono,
                color: TOKEN.label2,
              },
            }, props.consequences.map(function (line, i) {
              return h('div', { key: i }, '· ' + line)
            }))
            : null,
          h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            (props.actions || []).map(function (action) {
              return h('button', {
                key: action.id,
                style: S.button(action.primary === true),
                onClick: function () { props.onChoose(action.id) },
              }, action.label)
            }))
        ))
    }

    // ================= Tab 1：记忆库 =================

    function LibraryTab() {
      var st = React.useState({ rows: [], total: 0, q: '', selected: null, doc: null, editing: false, draft: '', msg: null })
      var s = st[0]
      var set = st[1]

      function merge(patch) {
        set(function (prev) { return Object.assign({}, prev, patch) })
      }

      var load = React.useCallback(function (q) {
        get('/library', { q: q }).then(function (r) {
          if (r.ok) merge({ rows: r.rows, total: r.total })
        })
      }, [])

      React.useEffect(function () { load('') }, [load])

      function pick(row) {
        get('/document', { docId: row.docId }).then(function (r) {
          if (r.ok) merge({ selected: row.docId, doc: r, editing: false, draft: r.body, msg: null })
        })
      }

      function save() {
        if (!s.doc) return
        merge({ msg: '保存中…' })
        post('/document/save', { docId: s.doc.docId, body: s.draft }).then(function (r) {
          if (r.ok) {
            merge({
              msg: '已保存，该篇索引已增量更新',
              editing: false,
              doc: Object.assign({}, s.doc, { body: s.draft }),
            })
            load(s.q)
          } else {
            merge({ msg: '保存失败：' + (r.error || '未知错误') })
          }
        })
      }

      var left = h('div', { style: { width: 300, flexShrink: 0 } },
        h('input', {
          style: S.input,
          placeholder: '按标题过滤…',
          value: s.q,
          onChange: function (e) {
            var q = e.target.value
            merge({ q: q })
            load(q)
          },
        }),
        h('div', { style: { fontSize: 11, color: TOKEN.label2, margin: '8px 0' } },
          '共 ' + s.total + ' 篇' + (s.q ? '，匹配 ' + s.rows.length + ' 篇' : '')),
        h('div', { style: { maxHeight: 560, overflow: 'auto' } },
          s.rows.map(function (row) {
            return h('div', {
              key: row.docId,
              style: S.listItem(s.selected === row.docId),
              onClick: function () { pick(row) },
              title: row.filename,
            },
              h('div', { style: { fontSize: 12, lineHeight: '18px' } }, row.title || row.filename),
              h('div', { style: { fontSize: 10, color: TOKEN.label2, marginTop: 2 } },
                (row.date || '未知日期') + ' · ' + row.chunks + ' chunk'))
          }))
      )

      var right
      if (s.doc === null) {
        right = h('div', { style: S.hint }, '← 从左侧选择一篇文档')
      } else {
        var meta = h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, s.doc.frontmatter.title || s.doc.filename),
          h('div', { style: S.mono },
            h('div', null, 'docId: ' + s.doc.docId),
            h('div', null, 'file: ' + s.doc.relativePath),
            h('div', null, 'created: ' + (s.doc.frontmatter.created_at || '—')),
            h('div', null, 'updated: ' + (s.doc.frontmatter.updated_at || '—')),
            h('div', null, 'revision: ' + (s.doc.frontmatter.revision || 1)),
            h('div', null, 'size: ' + s.doc.sizeBytes + ' 字节')),
          s.doc.frontmatter.description
            ? h('div', { style: { marginTop: 8, fontSize: 12, color: TOKEN.label2, lineHeight: '19px' } },
              s.doc.frontmatter.description)
            : null
        )

        var actions = h('div', { style: { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' } },
          h('button', {
            style: S.button(!s.editing),
            onClick: function () {
              merge({ editing: !s.editing, draft: s.doc.body })
            },
          }, s.editing ? '取消编辑' : '编辑正文'),
          s.editing
            ? h('button', { style: S.button(true), onClick: save }, '保存并重建该篇索引')
            : null,
          s.msg ? h('span', { style: { fontSize: 11, color: TOKEN.success } }, s.msg) : null
        )

        var bodyView = s.editing
          ? h('textarea', {
            style: Object.assign({}, S.input, { height: 460, resize: 'vertical', lineHeight: '19px' }),
            value: s.draft,
            onChange: function (e) {
              merge({ draft: e.target.value })
            },
          })
          : h('pre', { style: Object.assign({}, S.card, S.pre) }, s.doc.body)

        right = h('div', { style: S.col }, meta, actions, bodyView)
      }

      return h('div', { style: S.row }, left, right)
    }

    // ================= Tab 2：召回调试 =================

    function DebugTab() {
      var st = React.useState({ q: '', only: 'both', limit: 10, result: null, busy: false, error: null })
      var s = st[0]
      var set = st[1]

      function merge(patch) {
        set(function (prev) { return Object.assign({}, prev, patch) })
      }

      function run() {
        if (s.q.trim() === '') return
        merge({ busy: true, error: null })
        get('/recall', {
          q: s.q,
          limit: s.limit,
          only: s.only === 'both' ? undefined : s.only,
        }).then(function (r) {
          merge({ busy: false, result: r.ok ? r : null, error: r.ok ? null : (r.error || '请求失败') })
        })
      }

      var controls = h('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
        h('input', {
          style: Object.assign({}, S.input, { flex: 1 }),
          placeholder: '输入查询，回车执行…',
          value: s.q,
          onChange: function (e) { merge({ q: e.target.value }) },
          onKeyDown: function (e) { if (e.key === 'Enter') run() },
        }),
        h('select', {
          style: Object.assign({}, S.input, { width: 130, flexShrink: 0 }),
          value: s.only,
          onChange: function (e) { merge({ only: e.target.value }) },
        },
          h('option', { value: 'both' }, '混合召回'),
          h('option', { value: 'lexical' }, '仅词法'),
          h('option', { value: 'semantic' }, '仅向量')),
        h('button', { style: S.button(true), onClick: run, disabled: s.busy },
          s.busy ? '检索中…' : '检索')
      )

      if (s.error) {
        return h('div', null, controls,
          h('div', { style: Object.assign({}, S.card, { borderColor: TOKEN.error }) }, s.error))
      }

      if (s.result === null) {
        return h('div', null, controls,
          h('div', { style: S.hint },
            '输入查询后回车。这里能看到「词法 / 向量 / 融合」三路分别的分数，以及 BM25 实际看到的 token，'
            + '用来判断是哪一路在起作用、为什么某次召回是零命中。'))
      }

      var res = s.result
      var t = res.timing

      var stats = h('div', { style: Object.assign({}, S.card, { fontSize: 12 }) },
        h('span', { style: S.badge('info') }, 'K=' + res.k),
        h('span', { style: S.badge('muted') }, '词法 ' + t.lexicalCount + ' 条 / ' + t.lexicalMs + 'ms'),
        h('span', { style: S.badge(t.semanticSkipped ? 'warn' : 'muted') },
          '向量 ' + t.semanticCount + ' 条 / ' + t.semanticMs + 'ms'),
        h('span', { style: S.badge('muted') }, '融合 ' + t.fusedCount + ' → 去重 ' + t.dedupedCount),
        h('span', { style: S.badge('ok') }, '总 ' + t.totalMs + 'ms'),
        t.semanticSkipped
          ? h('div', { style: S.hint }, '向量通道未参与：' + t.semanticSkipped)
          : null,
        h('div', { style: { marginTop: 8 } },
          h('span', { style: S.label },
            'BM25 实际分出的 token（' + res.queryTokens.length + ' 个）——这就是为什么有时候会零命中'),
          h('div', { style: Object.assign({}, S.mono, { marginTop: 4 }) },
            res.queryTokens.slice(0, 100).join(' · ')))
      )

      if (res.hits.length === 0) {
        return h('div', null, controls, stats,
          h('div', { style: S.card }, '零命中。对照上方的分词结果，检查查询词是否与文档用词有字面重叠。'))
      }

      var hits = res.hits.map(function (hit, i) {
        return h('div', { key: hit.chunkId, style: S.card },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 } },
            h('span', { style: { fontWeight: 700, color: TOKEN.label2, minWidth: 26 } }, '#' + (i + 1)),
            h('span', { style: { fontWeight: 600, flex: 1 } }, hit.title || hit.filename),
            h('span', { style: S.badge('ok') }, '分 ' + hit.final)),
          h('div', null,
            h('span', { style: S.badge('muted') }, hit.date || '无日期'),
            h('span', { style: S.badge('info') }, '词法 ' + hit.lexical),
            h('span', { style: S.badge(hit.semantic === null ? 'muted' : 'info') },
              '向量 ' + (hit.semantic === null ? '—' : hit.semantic)),
            h('span', { style: S.badge('muted') }, 'RRF ' + hit.rrf),
            hit.moreChunks > 0
              ? h('span', { style: S.badge('warn') }, '同文档另 ' + hit.moreChunks + ' chunk（已折叠）')
              : null),
          hit.matched.length > 0
            ? h('div', { style: Object.assign({}, S.mono, { fontSize: 11, margin: '6px 0' }) },
              '命中 token：' + hit.matched.join(', '))
            : null,
          h('pre', { style: Object.assign({}, S.pre, { marginTop: 6 }) }, hit.excerpt + '…'))
      })

      return h('div', null, controls, stats, hits)
    }

    // ================= Tab 3：索引 =================

    function IndexTab() {
      var st = React.useState({ state: null, progress: null, verify: null, busy: false })
      var s = st[0]
      var set = st[1]
      var timer = React.useRef(null)

      function merge(patch) {
        set(function (prev) { return Object.assign({}, prev, patch) })
      }

      function loadOnce() {
        get('/state').then(function (r) {
          if (r.ok) merge({ state: r })
        })
        get('/index/progress').then(function (r) {
          if (!r.ok) return
          merge({ progress: r })
          if (r.building) {
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(loadOnce, 1200)
          }
        })
      }

      React.useEffect(function () {
        loadOnce()
        return function () { if (timer.current) clearTimeout(timer.current) }
      }, [])

      function rebuild(force) {
        merge({ busy: true })
        post('/index/rebuild', { force: force === true }).then(function (r) {
          merge({ busy: false })
          if (r.requiresConfirm) {
            var ok = window.confirm(
              (r.message || '索引配置不兼容') + '\n\n' + (r.hint || '') + '\n\n仍然重建？'
            )
            if (ok) rebuild(true)
            return
          }
          if (r.ok) {
            setTimeout(loadOnce, 400)
          } else {
            window.alert('重建失败：' + (r.error || '未知'))
          }
        })
      }

      function verify() {
        merge({ busy: true })
        post('/index/verify', {}).then(function (r) {
          merge({ busy: false, verify: r.verify || r })
        })
      }

      if (s.state === null) return h('div', { style: S.hint }, '加载中…')

      var idx = s.state.index
      var prog = s.progress && s.progress.status
      var building = s.progress && s.progress.building

      var tone = idx.hybridReady ? 'ok' : (idx.compatible.fatal ? 'err' : 'warn')
      var text = idx.hybridReady
        ? '可用（混合召回）'
        : idx.vectorsIndexed
          ? '向量已索引但查询侧不可用 → 仅关键词'
          : '仅关键词召回'

      var statusCard = h('div', { style: S.card },
        h('div', { style: { marginBottom: 10 } },
          h('span', { style: S.badge(tone) }, text),
          idx.compatible.ok ? null : h('span', { style: S.badge('warn') }, idx.compatible.reason || '')),
        h('div', { style: S.mono },
          h('div', null, '文档 ' + idx.docCount + ' 篇 · chunk ' + idx.chunkCount + ' · 已向量化 ' + idx.vectorized),
          h('div', null, '维度 ' + (idx.embedding ? idx.embedding.dimensions : '—') +
            ' · 模型 ' + (idx.embedding ? idx.embedding.model : '—')),
          h('div', null, '分块 ' + idx.chunkSize + ' / 重叠 ' + idx.chunkOverlap),
          h('div', null, '建立于 ' + (idx.builtAt || '尚未建立')),
          h('div', null, 'BM25 ' + idx.bm25.docCount + ' 文档 / ' + idx.bm25.vocabularySize + ' 词表'),
          h('div', null, '索引目录 ' + idx.indexDir)),
        idx.compatible.ok
          ? null
          : h('div', {
            style: {
              marginTop: 10,
              padding: 8,
              background: 'rgba(248, 81, 73, 0.16)',
              borderRadius: 6,
              fontSize: 12,
              lineHeight: '20px',
              whiteSpace: 'pre-wrap',
              color: TOKEN.error,
            },
          }, idx.compatible.message)
      )

      var buttons = h('div', { style: { display: 'flex', gap: 8, marginBottom: 12 } },
        h('button', { style: S.button(true), onClick: function () { rebuild(false) }, disabled: s.busy || building },
          building ? '构建中…' : '重建全量索引'),
        h('button', { style: S.button(false), onClick: verify, disabled: s.busy || building }, '校验完整性'),
        h('button', { style: S.button(false), onClick: loadOnce }, '刷新')
      )

      var progressCard = null
      if (building && prog) {
        progressCard = h('div', { style: S.card },
          h('div', { style: { marginBottom: 6, fontSize: 12 } },
            prog.message + '　' + prog.doneBatches + '/' + prog.totalBatches + ' 批'),
          h('div', { style: { height: 6, background: TOKEN.surface2, borderRadius: 3, overflow: 'hidden' } },
            h('div', {
              style: {
                height: '100%',
                width: Math.max(2, prog.progress) + '%',
                background: TOKEN.brand,
                transition: 'width 0.3s',
              },
            })),
          h('div', { style: S.hint }, '构建期间召回降级为纯关键词，对话不受影响。'))
      }

      var verifyCard = null
      if (s.verify) {
        var samples = s.verify.error
          ? h('div', { style: { color: TOKEN.error } }, s.verify.error)
          : (s.verify.samples || []).map(function (row) {
            return h('div', { key: row.chunkId, style: Object.assign({}, S.mono, { marginBottom: 3 }) },
              (row.similarity >= 0.999 ? '✓ ' : '✗ ') + row.similarity + '  ' +
              (row.title || row.chunkId) + (row.error ? '  [' + row.error + ']' : ''))
          })

        verifyCard = h('div', { style: S.card },
          h('div', { style: { marginBottom: 8 } },
            h('span', { style: S.badge(s.verify.ok ? 'ok' : 'err') },
              s.verify.ok ? '完整性通过' : '完整性异常'),
            s.verify.worst !== undefined
              ? h('span', { style: S.badge('muted') }, '最差相似度 ' + s.verify.worst)
              : null),
          samples,
          h('div', { style: S.hint },
            '抽查 5 个 chunk 重新 embed 并与磁盘向量比对。低于 0.999 说明配置不一致或索引损坏。'))
      }

      return h('div', null, statusCard, buttons, progressCard, verifyCard)
    }

    // ================= Tab 4：设置 =================

    function SettingsTab() {
      var st = React.useState({
        data: null,
        draft: null,
        msg: null,
        testResult: null,
        models: null,
        dialog: null,
        runtimeDraft: null,
        aliasText: '',
        folders: null,
        template: null,
        templateText: '',
        // 语义写自检：贴进来的正文 + 解析结果
        previewText: '',
        preview: null,
      })
      var s = st[0]
      var set = st[1]

      function merge(patch) {
        set(function (prev) { return Object.assign({}, prev, patch) })
      }

      function setTemplateState(patch) {
        set(function (prev) {
          return Object.assign({}, prev, {
            template: Object.assign({}, prev.template, patch),
            templateText: patch.template !== undefined ? patch.template : prev.templateText,
          })
        })
      }

      function setPreviewState(patch) {
        set(function (prev) { return Object.assign({}, prev, patch) })
      }

      /**
       * 自检：把一段正文发给后端，只看解析结果、不落盘。
       *
       * 语义写入的失败几乎都出在格式细节（漏空行、target 太短），
       * 而这类问题在运行日志里只表现为「没写进去」—— 有这个框，
       * 用户不用翻日志就能看到系统到底把它读成了什么。
       */
      function runPreview(text) {
        var body = (text === undefined ? s.previewText : text) || ''
        if (body.trim() === '') {
          merge({ preview: { found: 0, rows: [], hint: '请先粘贴一段带块的正文。' } })
          return
        }
        // 用 POST：一整篇日记塞进 query string 会被长度限制截断，
        // 而截断后的正文里往往还剩块起始标记、却没了结束标记 ——
        // 解析结果变成 0 个块，看起来像功能坏了。
        post('/diary/semantic/preview', { text: body }).then(function (r) {
          if (r.ok) merge({ preview: r })
          else merge({ preview: { found: 0, rows: [], hint: r.error || '解析失败' } })
        })
      }

      function load() {
        get('/settings').then(function (r) {
          if (r.ok) merge({ data: r, draft: JSON.parse(JSON.stringify(r.config)) })
        })
        get('/runtime').then(function (r) {
          if (r.ok) merge({ runtimeDraft: JSON.parse(JSON.stringify(r.memories)) })
        })
        get('/aliases').then(function (r) {
          if (r.ok) merge({ aliasText: JSON.stringify(r.aliases, null, 2) })
        })
        get('/diary/folders').then(function (r) {
          if (r.ok) merge({ folders: r })
        })
        loadTemplate()
      }

      React.useEffect(function () { load() }, [])

      /**
       * 注入位置选择器。
       *
       * 两个选项对应两种物理位置，差异是「上游清空 system prompt 时谁存活」：
       *   section/context → 进 system，缓存最优，但 system 被清空就全丢
       *   message         → 进对话历史，survive 上游清空，但历史里删不掉
       *
       * 所以文案必须把这个取舍讲清楚，否则用户不知道什么时候该切。
       *
       * opts.maxMessages 有值时（= message 模式的条数上限）：
       * 选中「对话消息」后展开一个数字输入框。只在 message 模式显示，
       * 因为 prompt 模式不落库、没有上限这回事。
       */
      function injectModePicker(opts) {
        var value = opts.value === 'message' ? 'message' : (opts.defaultMode || 'prompt')
        // 统一归一化：runtime 默认 section、inject 默认 context，UI 上都叫「system prompt」
        var isMessage = opts.value === 'message'
        var hasCap = opts.maxMessages !== undefined && opts.maxMessages !== null
        return h('div', { style: { marginBottom: 10 } },
          h('label', { style: S.label }, opts.label),
          h('div', { style: { display: 'flex', gap: 8, marginBottom: 6 } },
            h('button', {
              style: S.button(!isMessage),
              onClick: function () { if (isMessage) opts.onChange(opts.systemValue || 'section') },
            }, '系统提示词'),
            h('button', {
              style: S.button(isMessage),
              onClick: function () { if (!isMessage) opts.onChange('message') },
            }, '对话消息')),

          (isMessage && hasCap)
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
              h('label', { style: Object.assign({}, S.label, { marginBottom: 0, flexShrink: 0 }) },
                '最多保留几条'),
              h('input', {
                style: Object.assign({}, S.input, { width: 90 }),
                type: 'number',
                min: 0,
                max: 200,
                // 标明这个框属于哪条通道，便于自检脚本定位（不参与渲染）
                'data-cap': opts.capKey || '',
                value: String(opts.maxMessages),
                onChange: function (e) {
                  var raw = e.target.value
                  // 空输入不立刻写 0，否则用户删光重打的过程中会被当成「不限制」
                  if (raw === '') return
                  var n = Math.round(Number(raw))
                  if (!Number.isFinite(n)) return
                  opts.onMaxMessages(Math.max(0, Math.min(200, n)))
                },
              }),
              h('span', { style: Object.assign({}, S.hint, { marginBottom: 0 }) },
                String(opts.maxMessages) === '0' ? '0 = 不限制' : '条'))
            : null,

          h('div', { style: S.hint },
            opts.help,
            (isMessage && hasCap)
              ? ' 上限只在「有新内容想进但进不去」时才有意义：到顶后旧消息删不掉，'
                + '调高上限（或填 0 不限）就能继续追加。'
              : ''))
      }

      /**
       * 分词器状态文案。
       *
       * 三态必须同时暴露，缺一个就会让人误判：
       *   configured（下拉框里选的） / active（实际能用的） / indexed（索引建的时候用的）
       *
       * 典型坑：选 auto 但机器上没装 jieba → active 是 gram 而界面毫无提示，
       * 用户会以为是 jieba 效果不好。反过来，装了之后 indexed 还是 gram，
       * 不重建索引的话查询词表与索引词表对不上，BM25 静默全 0 分。
       */
      function activeTokenizerText(s) {
        // 状态挂在 /settings 响应上（s.data.tokenizer），不在 draft 里 ——
        // draft 只有用户「想选什么」，active/indexed 是服务端事实。
        var t = s.data && s.data.tokenizer
        if (!t) return '分词器状态未知'
        var lines = []
        var configLabel = t.configured === 'gram' ? 'gram（强制）' : (t.configured === 'jieba' ? 'jieba（强制）' : 'auto')
        lines.push('已选：' + configLabel + ' · 实际生效：' + (t.active || '?'))
        if (t.configured !== 'gram' && t.active === 'gram') {
          lines.push('⚠ jieba 未装上，已自动降级为 1-gram + 2-gram'
            + (t.loadError ? '（' + String(t.loadError).slice(0, 80) + '）' : ''))
        }
        if (t.indexed && t.active && t.indexed !== t.active) {
          lines.push('⚠ 索引是用 ' + t.indexed + ' 建的，与当前 ' + t.active + ' 不一致 —— 请重建索引，否则词表对不上、BM25 会全 0 分。')
        }
        return lines.join(' ')
      }

      /** 改 draft 的某个路径。 */
      function patch(path, value) {
        var next = JSON.parse(JSON.stringify(s.draft))
        var parts = path.split('.')
        var target = next
        for (var i = 0; i < parts.length - 1; i += 1) {
          // 中间段可能不存在：老版本配置文件里没有 judge 段，
          // 此时 target['judge'] 是 undefined，下一行赋值就会 TypeError
          // 把整个设置页炸掉。这里按需补出来。
          if (target[parts[i]] === null || typeof target[parts[i]] !== 'object') {
            target[parts[i]] = {}
          }
          target = target[parts[i]]
        }
        target[parts[parts.length - 1]] = value
        merge({ draft: next })
      }

      function save(force) {
        merge({ msg: '保存中…' })
        post('/settings/save', { config: s.draft, force: force === true }).then(function (r) {
          if (r.requiresConfirm) {
            // 维度保护：弹窗让用户选
            merge({
              msg: null,
              dialog: {
                title: r.title || '配置变更将导致索引失效',
                message: r.message,
                consequences: r.consequences,
                actions: r.actions,
              },
            })
            return
          }
          if (r.ok) {
            merge({
              msg: '已保存' + (r.warning ? '（' + r.warning + '）' : ''),
              data: Object.assign({}, s.data, { config: r.config }),
            })
            setTimeout(function () { merge({ msg: null }) }, 5000)
          } else {
            merge({ msg: '保存失败：' + (r.error || '未知') })
          }
        })
      }

      function onDialogChoose(id) {
        merge({ dialog: null })
        if (id === 'cancel') return
        if (id === 'rebuild') {
          post('/settings/save', { config: s.draft, force: true }).then(function (r) {
            if (!r.ok) {
              merge({ msg: '保存失败：' + (r.error || '未知') })
              return
            }
            merge({ msg: '配置已保存，开始重建索引…' })
            post('/index/rebuild', { force: true }).then(function (rb) {
              if (rb.ok) merge({ msg: '重建已启动，切到「索引」Tab 看进度' })
              else merge({ msg: '重建启动失败：' + (rb.error || '未知') })
            })
          })
          return
        }
        if (id === 'save') save(true)
      }

      function testConnection() {
        merge({ testResult: { pending: true } })
        post('/settings/test', { embedding: s.draft.embedding }).then(function (r) {
          merge({ testResult: r })
        })
      }

      function fetchModels() {
        merge({ models: { pending: true } })
        get('/models', { baseUrl: s.draft.embedding.baseUrl }).then(function (r) {
          merge({ models: r })
        })
      }

      function saveRuntime() {
        post('/runtime/save', { memories: s.runtimeDraft }).then(function (r) {
          if (r.ok) {
            merge({ msg: r.warning || '已保存' })
            setTimeout(function () { merge({ msg: null }) }, 6000)
          } else {
            merge({ msg: '保存失败：' + (r.error || '未知') })
          }
        })
      }

      function saveAliases() {
        var parsed
        try {
          parsed = JSON.parse(s.aliasText)
        } catch (e) {
          merge({ msg: '别名表不是合法 JSON：' + e.message })
          return
        }
        post('/aliases/save', { aliases: parsed }).then(function (r) {
          merge({ msg: r.ok ? '别名表已保存（' + r.count + ' 组）' : ('保存失败：' + r.error) })
          setTimeout(function () { merge({ msg: null }) }, 4000)
        })
      }

      // ---- 日记模板 ----
      function loadTemplate() {
        get('/diary/template').then(function (r) {
          if (r.ok) merge({ template: r, templateText: r.template })
        })
      }

      function saveTemplate(text, enabled) {
        merge({ msg: '保存模板中…' })
        post('/diary/template/save', {
          template: text === undefined ? s.templateText : text,
          enabled: enabled,
        }).then(function (r) {
          if (r.ok) {
            merge({ msg: r.warning || '日记模板已保存' })
            loadTemplate()
            setTimeout(function () { merge({ msg: null }) }, 8000)
          } else {
            merge({ msg: '模板保存失败：' + (r.error || '未知') })
          }
        })
      }

      if (s.data === null) return h('div', { style: S.hint }, '加载中…')

      var d = s.draft
      // 裁判配置的兜底：老版本的 config 里没有 judge 段，直接读 d.judge.enabled
      // 会 TypeError 把整个设置页炸掉。这里给一份与 lib/config.js DEFAULTS.judge
      // 对齐的默认值 —— 两处必须一起改，否则面板显示的和实际生效的会不一致。
      var jd = Object.assign({
        enabled: false,
        threshold: 0.7,
        maxCandidates: 12,
        concurrency: 8,
        timeoutMs: 4000,
        candidateChars: 400,
        queryChars: 400,
      }, d.judge || {})
      var manifest = s.data.manifestEmbedding

      // ---- A. Embedding 渠道 ----
      var channelCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: 10 } }, 'A. Embedding 渠道'),
        h('div', null,
          h('div', { style: { marginBottom: 8 } },
            h('span', { style: S.badge(d.embedding.enabled ? 'ok' : 'muted') },
              d.embedding.enabled ? '已启用' : '已关闭'),
            manifest
              ? h('span', { style: S.badge('info') },
                '索引记录：' + manifest.dimensions + ' 维 / ' + manifest.model)
              : h('span', { style: S.badge('warn') }, '尚无索引'),
            s.data.keyPresent
              ? h('span', { style: S.badge('ok') }, '密钥已配置')
              : h('span', { style: S.badge('err') }, '密钥缺失')),

          h('label', { style: S.label }, 'Base URL（必须含 /v1，否则会打到网关首页返回 HTML）'),
          h('input', {
            style: Object.assign({}, S.input, { marginBottom: 8 }),
            value: d.embedding.baseUrl,
            onChange: function (e) { patch('embedding.baseUrl', e.target.value) },
          }),

          h('label', { style: S.label }, 'API Key（留空则用环境变量 VCPRAG_EMBEDDING_KEY）'),
          h('input', {
            style: Object.assign({}, S.input, { marginBottom: 8 }),
            type: 'password',
            placeholder: s.data.keyPresent ? '••••••••（已配置，留空不修改）' : '未配置',
            value: d.embedding.apiKey && d.embedding.apiKey.indexOf('•') === -1 ? d.embedding.apiKey : '',
            onChange: function (e) { patch('embedding.apiKey', e.target.value) },
          }),

          h('div', { style: { display: 'flex', gap: 8 } },
            h('div', { style: { flex: 2 } },
              h('label', { style: S.label }, '模型'),
              h('input', {
                style: Object.assign({}, S.input, { marginBottom: 8 }),
                value: d.embedding.model,
                onChange: function (e) { patch('embedding.model', e.target.value) },
              })),
            h('div', { style: { flex: 1 } },
              h('label', { style: S.label }, '维度'),
              h('input', {
                style: Object.assign({}, S.input, { marginBottom: 8 }),
                type: 'number',
                value: d.embedding.dimensions,
                onChange: function (e) { patch('embedding.dimensions', Number(e.target.value)) },
              }))),

          h('div', { style: { display: 'flex', gap: 8 } },
            h('div', { style: { flex: 1 } },
              h('label', { style: S.label }, '批量大小（实测上限 16，超过会 ECONNRESET）'),
              h('input', {
                style: Object.assign({}, S.input, { marginBottom: 8 }),
                type: 'number',
                min: 1,
                max: 16,
                value: d.embedding.batchSize,
                onChange: function (e) { patch('embedding.batchSize', Number(e.target.value)) },
              })),
            h('div', { style: { flex: 1 } },
              h('label', { style: S.label }, '并发（网关限流 100 请求/分钟）'),
              h('input', {
                style: Object.assign({}, S.input, { marginBottom: 8 }),
                type: 'number',
                min: 1,
                max: 8,
                value: d.embedding.concurrency,
                onChange: function (e) { patch('embedding.concurrency', Number(e.target.value)) },
              })),
            h('div', { style: { flex: 1 } },
              h('label', { style: S.label }, '请求间隔 ms'),
              h('input', {
                style: Object.assign({}, S.input, { marginBottom: 8 }),
                type: 'number',
                value: d.embedding.minIntervalMs,
                onChange: function (e) { patch('embedding.minIntervalMs', Number(e.target.value)) },
              }))),

          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('button', { style: S.button(false), onClick: testConnection }, '测试连接'),
            h('button', { style: S.button(false), onClick: fetchModels }, '拉取模型列表'),
            s.testResult && s.testResult.pending
              ? h('span', { style: S.hint }, '测试中…')
              : null,
            s.testResult && !s.testResult.pending
              ? h('span', {
                style: { fontSize: 12, color: s.testResult.ok && s.testResult.match ? TOKEN.success : TOKEN.error },
              },
                s.testResult.ok
                  ? (s.testResult.match
                    ? '✓ 连接正常 · ' + s.testResult.dimensions + ' 维 · ' + s.testResult.elapsedMs + 'ms'
                    : '⚠ 维度不符：配置 ' + s.testResult.expected + '，实际返回 ' + s.testResult.dimensions)
                  : '✗ ' + (s.testResult.error || '失败'))
              : null),

          s.models
            ? h('div', { style: Object.assign({}, S.hint, { marginTop: 8 }) },
              s.models.pending
                ? '拉取中…'
                : s.models.ok
                  ? '共 ' + s.models.total + ' 个模型，其中 embedding 类 ' + s.models.embeddings.length + ' 个：'
                    + (s.models.embeddings.length ? s.models.embeddings.join(' · ') : '（无）')
                  : '拉取失败：' + (s.models.error || '未知'))
            : null)
      )

      // ---- B. 召回参数 ----
      var recallCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: 10 } }, 'B. 召回参数'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          [['kBase', '基础 K'], ['kMin', '最小 K'], ['kMax', '最大 K']].map(function (pair) {
            return h('div', { key: pair[0], style: { width: 110 } },
              h('label', { style: S.label }, pair[1]),
              h('input', {
                style: Object.assign({}, S.input, { marginBottom: 8 }),
                type: 'number',
                value: d.recall[pair[0]],
                onChange: function (e) { patch('recall.' + pair[0], Number(e.target.value)) },
              }))
          }),
          [['lexicalLimit', '词法候选'], ['semanticLimit', '向量候选'], ['maxChars', '注入上限字数']].map(function (pair) {
            return h('div', { key: pair[0], style: { width: 130 } },
              h('label', { style: S.label }, pair[1]),
              h('input', {
                style: Object.assign({}, S.input, { marginBottom: 8 }),
                type: 'number',
                value: d.recall[pair[0]],
                onChange: function (e) { patch('recall.' + pair[0], Number(e.target.value)) },
              }))
          })),
        // ---- 分词器 ----
        // 这一项决定整张词表，改了必须重建索引才生效。所以除了 select，
        // 还要把「当前实际生效的引擎」摊开显示 —— 用户选了 auto，
        // 但机器上可能根本没装 jieba，光看 select 是发现不了的。
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4, alignItems: 'flex-end' } },
          h('div', { style: { width: 190 } },
            h('label', { style: S.label }, '分词器（改后需重建索引）'),
            h('select', {
              style: Object.assign({}, S.input, { marginBottom: 8 }),
              value: d.recall.tokenizer || 'auto',
              onChange: function (e) { patch('recall.tokenizer', e.target.value) },
            },
              h('option', { value: 'auto' }, 'auto（有 jieba 就用）'),
              h('option', { value: 'jieba' }, 'jieba（真词典分词）'),
              h('option', { value: 'gram' }, 'gram（1-gram，零依赖）'))),
          h('div', { style: Object.assign({}, S.hint, { flex: 1, marginBottom: 10 }) },
            activeTokenizerText(s))),

        // ---- 相关性闸门 ----
        // 不加这两个开关，无论查询多无关都会硬返回 k 条「最不无关」的结果，
        // 日志显示注入成功、内容是噪声。实测见 lib/config.js 的 minSemantic。
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4, alignItems: 'flex-end' } },
          h('div', { style: { width: 150 } },
            h('label', { style: S.label }, '相关性闸门（余弦下限）'),
            h('input', {
              style: Object.assign({}, S.input, { marginBottom: 8 }),
              type: 'number',
              step: 0.05,
              min: 0,
              max: 0.99,
              value: d.recall.minSemantic,
              onChange: function (e) { patch('recall.minSemantic', Number(e.target.value)) },
            })),
          h('div', { style: { width: 190 } },
            h('label', { style: S.label }, '必须被语义通道命中'),
            h('label', { style: Object.assign({}, S.label, { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }) },
              h('input', {
                type: 'checkbox',
                checked: d.recall.requireSemantic !== false,
                onChange: function (e) { patch('recall.requireSemantic', e.target.checked) },
              }),
              '开（推荐）')),
          h('div', { style: Object.assign({}, S.hint, { flex: 1, marginBottom: 10 }) },
            '低于下限的候选直接丢弃；全被丢光就不注入。填 0 关闭闸门。只在语义通道可用时生效。')),

        // ---- 相关性裁判（可选，默认关闭）----
        // 实词判据问的是「query 里有没有罕见词」，裁判问的是「这条日记跟
        // query 讲的是不是同一件事」。实测「条目级去重」被 jieba 切成
        // 条目/级/重 之后，主题词消失、只剩通用词过闸门 —— 判据问错了问题。
        //
        // 这里只暴露数值项。**密钥不在这里**：配置文件会被 UI 读出来回显到
        // 浏览器，把 key 塞进面板等于把它摊在明面上。key 只走环境变量。
        h('div', {
          style: {
            marginTop: 14,
            paddingTop: 12,
            borderTop: '1px solid ' + (TOKEN.border || '#e5e7eb'),
          },
        },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '相关性裁判（可选）'),
          h('div', { style: Object.assign({}, S.hint, { marginBottom: 10 }) },
            '用一个判断模型直接判「这条记忆与当前查询是不是同一个主题」，',
            '绕开分词（「去重」被切成「去/重」也不影响）。',
            '代价是每次召回多一笔外部请求（实测 12 条约 1.2~2.0 秒）。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' } },
            h('div', { style: { width: 140 } },
              h('label', { style: S.label }, '启用裁判'),
              h('label', { style: Object.assign({}, S.label, { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }) },
                h('input', {
                  type: 'checkbox',
                  checked: jd.enabled === true,
                  onChange: function (e) { patch('judge.enabled', e.target.checked) },
                }),
                jd.enabled === true ? '开' : '关（默认）')),
            h('div', { style: { width: 130 } },
              h('label', { style: S.label }, '剔除阈值（0~1）'),
              h('input', {
                style: Object.assign({}, S.input, { marginBottom: 8 }),
                type: 'number',
                step: 0.05,
                min: 0,
                max: 1,
                value: jd.threshold,
                onChange: function (e) { patch('judge.threshold', Number(e.target.value)) },
              })),
            h('div', { style: { width: 110 } },
              h('label', { style: S.label }, '最多判几条'),
              h('input', {
                style: Object.assign({}, S.input, { marginBottom: 8 }),
                type: 'number',
                min: 1,
                max: 50,
                value: jd.maxCandidates,
                onChange: function (e) { patch('judge.maxCandidates', Number(e.target.value)) },
              })),
            h('div', { style: { width: 100 } },
              h('label', { style: S.label }, '并发数'),
              h('input', {
                style: Object.assign({}, S.input, { marginBottom: 8 }),
                type: 'number',
                min: 1,
                max: 16,
                value: jd.concurrency,
                onChange: function (e) { patch('judge.concurrency', Number(e.target.value)) },
              })),
            h('div', { style: { width: 120 } },
              h('label', { style: S.label }, '超时（毫秒）'),
              h('input', {
                style: Object.assign({}, S.input, { marginBottom: 8 }),
                type: 'number',
                min: 200,
                max: 60000,
                value: jd.timeoutMs,
                onChange: function (e) { patch('judge.timeoutMs', Number(e.target.value)) },
              }))),

          // ---- 连接信息：端点 / 模型 / 代理 / 密钥 ----
          // 这四项以前只认环境变量，改一次要重启宿主进程。现在面板可改。
          // 留空 = 回落到环境变量或内置默认，两种用法可以共存。
          h('div', { style: { marginTop: 10 } },
            h('label', { style: S.label }, '端点 URL（留空用官方端点）'),
            h('input', {
              style: Object.assign({}, S.input, { marginBottom: 8 }),
              placeholder: 'https://api.typesafe.ai/v1/systemone',
              value: jd.baseUrl || '',
              onChange: function (e) { patch('judge.baseUrl', e.target.value) },
            }),

            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('div', { style: { flex: 1, minWidth: 180 } },
                h('label', { style: S.label }, '模型名（留空用 jev-latest）'),
                h('input', {
                  style: Object.assign({}, S.input, { marginBottom: 8 }),
                  placeholder: 'jev-latest',
                  value: jd.model || '',
                  onChange: function (e) { patch('judge.model', e.target.value) },
                })),
              h('div', { style: { flex: 1, minWidth: 180 } },
                h('label', { style: S.label }, '代理地址（451 地区必填）'),
                h('input', {
                  style: Object.assign({}, S.input, { marginBottom: 8 }),
                  placeholder: 'http://127.0.0.1:7897',
                  value: jd.proxyUrl || '',
                  onChange: function (e) { patch('judge.proxyUrl', e.target.value) },
                }))),

            h('label', { style: S.label }, 'API Key（留空则用 VCPRAG_JUDGE_KEY）'),
            // 掩码回显：后端把已配置的 key 回成八个圆点，保存时含圆点的值
            // 一律视为「没改动」—— 与上面 embedding.apiKey 同一套机制。
            h('input', {
              style: Object.assign({}, S.input, { marginBottom: 8 }),
              type: 'password',
              placeholder: jd.apiKey && jd.apiKey.indexOf('•') !== -1
                ? '••••••••（已配置，留空不修改）'
                : '未配置',
              value: jd.apiKey && jd.apiKey.indexOf('•') === -1 ? jd.apiKey : '',
              onChange: function (e) { patch('judge.apiKey', e.target.value) },
            })),
          h('div', { style: Object.assign({}, S.hint, { marginTop: 6 }) },
            // 阈值是实测值，直接把依据写出来，否则用户只会看到一个大而空的 0.7
            '阈值默认 0.7 是实测值：5 个查询 × 8 篇真实日记，「相关」最低 0.94、',
            '「全无关」最高 0.12；取中点 0.53 会让一条 0.61 的噪声漏进来。',
            '换语料请重新校准。'),
          h('div', { style: Object.assign({}, S.hint, { marginTop: 4 }) },
            '密钥只走环境变量 ',
            h('code', { style: { fontFamily: 'monospace' } }, 'VCPRAG_JUDGE_KEY'),
            '（可选 ',
            h('code', { style: { fontFamily: 'monospace' } }, 'VCPRAG_JUDGE_URL'),
            ' / ',
            h('code', { style: { fontFamily: 'monospace' } }, 'VCPRAG_JUDGE_MODEL'),
            '）。开了开关但没设 key 会在日志里告警并按关闭处理。'),
          h('div', { style: Object.assign({}, S.hint, { marginTop: 4 }) },
            '官方端点对部分地区返回 451（Typesafe is not available in your region）。',
            '两种绕法：① 填上面的「代理地址」（如 http://127.0.0.1:7897）走 CONNECT 隧道；',
            '② 把「端点 URL」换成自建的反向代理（插件自带一个 Cloudflare Worker，',
            '见 worker/jev-proxy/README.md），那样代理地址留空即可。',
            '两者都没配时直连会静默失败 —— 开关是开的、日志也不报错，只是裁判不生效。'),
          h('div', { style: Object.assign({}, S.hint, { marginTop: 4 }) },
            '四项连接信息留空则回落到环境变量：',
            h('code', { style: { fontFamily: 'monospace' } }, 'VCPRAG_JUDGE_KEY'),
            ' / ',
            h('code', { style: { fontFamily: 'monospace' } }, 'VCPRAG_JUDGE_URL'),
            ' / ',
            h('code', { style: { fontFamily: 'monospace' } }, 'VCPRAG_JUDGE_MODEL'),
            ' / ',
            h('code', { style: { fontFamily: 'monospace' } }, 'VCPRAG_JUDGE_PROXY'),
            '。环境变量优先级更高，便于临时换 key 而不动配置文件。'),
          jd.enabled === true
            ? h('div', { style: Object.assign({}, S.hint, { marginTop: 4, color: TOKEN.warn || '#b45309' }) },
              '提示：面板和环境变量都没给 API Key 时，这一项不会生效（日志会告警）。改完点「保存」即可，无需重启。')
            : null),

        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 } },
          h('div', { style: { width: 130 } },
            h('label', { style: S.label }, '时间衰减半衰期（天）'),
            h('input', {
              style: S.input,
              type: 'number',
              value: d.timeDecay.halfLifeDays,
              onChange: function (e) { patch('timeDecay.halfLifeDays', Number(e.target.value)) },
            })),
          h('div', { style: { width: 130 } },
            h('label', { style: S.label }, '衰减下限（0~1）'),
            h('input', {
              style: S.input,
              type: 'number',
              step: 0.05,
              value: d.timeDecay.floor,
              onChange: function (e) { patch('timeDecay.floor', Number(e.target.value)) },
            })),
          h('div', { style: { width: 150 } },
            h('label', { style: S.label }, '分块大小'),
            h('input', {
              style: S.input,
              type: 'number',
              value: d.chunkSize,
              onChange: function (e) { patch('chunkSize', Number(e.target.value)) },
            })),
          h('div', { style: { width: 150 } },
            h('label', { style: S.label }, '分块重叠'),
            h('input', {
              style: S.input,
              type: 'number',
              value: d.chunkOverlap,
              onChange: function (e) { patch('chunkOverlap', Number(e.target.value)) },
            }))),
        h('div', { style: S.hint },
          '改动分块参数会导致现有 chunk 与新切分不一致，建议重建索引。')
      )

      // ---- C. 冻结行为 ----
      var freezeCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: 10 } }, 'C. 冻结行为'),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('input', {
            type: 'checkbox',
            checked: d.freeze.onUserMessage,
            onChange: function (e) { patch('freeze.onUserMessage', e.target.checked) },
          }),
          h('span', null, '用户发新消息时重新召回')),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('input', {
            type: 'checkbox',
            checked: d.freeze.onTodoCheck,
            onChange: function (e) { patch('freeze.onTodoCheck', e.target.checked) },
          }),
          h('span', null, 'todo 出现新勾选时重新召回（阶段推进）')),
        h('div', { style: S.hint },
          '其余轮次（模型连续干活、普通工具调用）召回内容保持不变 → 前缀缓存全程命中。'
          + '关掉这两项等于回到「每轮都追加」，命中率会掉。')
      )

      // ---- D. runtime 记忆（常驻注入） ----
      var runtimeCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: 10 } }, 'D. runtime 记忆（常驻注入）'),
        h('div', { style: Object.assign({}, S.hint, { marginBottom: 10 }) },
          '这些内容每次对话都会全量注入。因为内容恒定，不影响前缀缓存；'
          + '但修改后会重建一次缓存前缀，建议改完开新会话。'),
        injectModePicker({
          label: '常驻记忆注入位置',
          value: d.runtime.mode,
          systemValue: 'section',
          maxMessages: d.runtime.maxMessages,
          capKey: 'runtime',
          help: '「system prompt」是缓存最优路径：内容恒定，一次写入永久命中。'
            + '若你的反代上游会对 system prompt 做指纹检测并清空它，内容会整体丢失 —— '
            + '此时切到「对话消息」：消息在对话历史里，不受 system 被清空影响（代价是历史里删不掉旧版本）。',
          onChange: function (v) { patch('runtime.mode', v) },
          onMaxMessages: function (n) { patch('runtime.maxMessages', n) },
        }),
        (s.runtimeDraft || []).map(function (mem, i) {
          return h('div', { key: i, style: { marginBottom: 10 } },
            h('div', { style: { display: 'flex', gap: 8, marginBottom: 4 } },
              h('select', {
                style: Object.assign({}, S.input, { width: 110, flexShrink: 0 }),
                value: mem.importance,
                onChange: function (e) {
                  var next = s.runtimeDraft.slice()
                  next[i] = Object.assign({}, mem, { importance: e.target.value })
                  merge({ runtimeDraft: next })
                },
              },
                h('option', { value: 'critical' }, '必须遵守'),
                h('option', { value: 'normal' }, '一般事实')),
              h('select', {
                style: Object.assign({}, S.input, { width: 100, flexShrink: 0 }),
                value: mem.target,
                onChange: function (e) {
                  var next = s.runtimeDraft.slice()
                  next[i] = Object.assign({}, mem, { target: e.target.value })
                  merge({ runtimeDraft: next })
                },
              },
                h('option', { value: 'memory' }, 'memory'),
                h('option', { value: 'user' }, 'user')),
              h('button', {
                style: S.button(false),
                onClick: function () {
                  var next = s.runtimeDraft.slice()
                  next.splice(i, 1)
                  merge({ runtimeDraft: next })
                },
              }, '删除')),
            h('textarea', {
              style: Object.assign({}, S.input, { height: 68, resize: 'vertical', lineHeight: '19px' }),
              value: mem.content,
              onChange: function (e) {
                var next = s.runtimeDraft.slice()
                next[i] = Object.assign({}, mem, { content: e.target.value })
                merge({ runtimeDraft: next })
              },
            }))
        }),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
          h('button', {
            style: S.button(false),
            onClick: function () {
              var next = (s.runtimeDraft || []).concat([{
                content: '',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                target: 'memory',
                importance: 'normal',
              }])
              merge({ runtimeDraft: next })
            },
          }, '+ 新增一条'),
          h('button', { style: S.button(true), onClick: saveRuntime }, '保存 runtime 记忆'))
      )

      // ---- E. 别名表 ----
      var aliasCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: 10 } }, 'E. 同义词别名表'),
        h('div', { style: Object.assign({}, S.hint, { marginBottom: 8 }) },
          '解决「缩写 ↔ 全称」这类字面零重叠的问题。格式：'
          + ' { "规范名": ["别名1", "别名2"] }。命中任一词即把整组词都注入检索。'),
        h('textarea', {
          style: Object.assign({}, S.input, {
            height: 200,
            resize: 'vertical',
            fontFamily: TOKEN.mono,
            fontSize: 12,
            lineHeight: '18px',
          }),
          value: s.aliasText,
          onChange: function (e) { merge({ aliasText: e.target.value }) },
        }),
        h('div', { style: { marginTop: 8 } },
          h('button', { style: S.button(true), onClick: saveAliases }, '保存别名表'))
      )

      // ---- F. 日记存放 ----
      var folderOptions = [{ name: '', label: '（根目录）' }]
        .concat(((s.folders && s.folders.folders) || []).filter(function (f) { return f.name !== '' }))
      var diaryCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: 10 } }, 'F. 日记存放'),
        h('label', { style: S.label }, '日记根目录（新写的 .txt 全部落在这里）'),
        h('input', {
          style: Object.assign({}, S.input, { marginBottom: 6 }),
          value: d.diaryRoot || '',
          placeholder: '留空则用 $VCPRAG_DIARY_DIR 或 <cwd>/diaries',
          onChange: function (e) { patch('diaryRoot', e.target.value) },
        }),
        s.folders && s.folders.root
          ? h('div', { style: Object.assign({}, S.hint, { marginBottom: 10 }) },
            '当前实际路径：' + s.folders.root
            + '（根目录 ' + ((s.folders.folders[0] && s.folders.folders[0].count) || 0) + ' 篇）')
          : null,

        h('label', { style: S.label }, '默认分类子目录（写入时可选覆盖）'),
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
          h('input', {
            style: S.input,
            value: d.diary.folder || '',
            placeholder: '留空 = 直接写根目录',
            onChange: function (e) { patch('diary.folder', e.target.value) },
          }),
          h('select', {
            style: Object.assign({}, S.input, { width: 200, flexShrink: 0 }),
            value: d.diary.folder || '',
            onChange: function (e) { patch('diary.folder', e.target.value) },
          }, folderOptions.map(function (f) {
            return h('option', { key: f.name || '__root', value: f.name },
              f.label + (f.count !== undefined ? '（' + f.count + '）' : ''))
          }))),

        h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 } },
          h('div', { style: { width: 160 } },
            h('label', { style: S.label }, '写入格式'),
            h('select', {
              style: S.input,
              value: d.diary.format,
              onChange: function (e) { patch('diary.format', e.target.value) },
            },
              h('option', { value: 'txt' }, 'txt（纯文本日记）'),
              h('option', { value: 'md' }, 'md（带 frontmatter）'))),
          h('div', { style: { width: 200 } },
            h('label', { style: S.label }, 'runtime 记忆文件'),
            h('input', {
              style: S.input,
              value: d.diary.runtimeFile || '',
              placeholder: '留空 = <语料>/runtime/memories.json',
              onChange: function (e) { patch('diary.runtimeFile', e.target.value) },
            }))),

        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('input', {
            type: 'checkbox',
            checked: d.diary.timePrefix,
            onChange: function (e) { patch('diary.timePrefix', e.target.checked) },
          }),
          h('span', null, '强制正文以 [HH:MM] 开头（不合规时警告而非阻拦）')),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('input', {
            type: 'checkbox',
            checked: d.diary.requireTag,
            onChange: function (e) { patch('diary.requireTag', e.target.checked) },
          }),
          h('span', null, '强制正文末行是 Tag: ...')),
        h('div', { style: S.hint },
          '改动目录或格式不会动已存在的文件；改完记得重建索引让新目录进场。')
      )

      // ---- G. 注入文案与占位符 ----
      var injectCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: 10 } }, 'G. 注入文案与占位符'),
        h('div', { style: Object.assign({}, S.hint, { marginBottom: 10 }) },
          '召回块的外层标签与措辞。不同模型对「这是背景知识」还是「这是待办」的敏感度不同，值得自己调。'),

        injectModePicker({
          label: '召回注入位置',
          value: d.inject.mode,
          systemValue: 'context',
          maxMessages: d.inject.maxMessages,
          capKey: 'inject',
          help: '默认进 system prompt（尾部追加，被冻结机制压制）。若上游会清空 system prompt，'
            + '切到「对话消息」以保证召回内容仍能送达模型。',
          onChange: function (v) { patch('inject.mode', v) },
          onMaxMessages: function (n) { patch('inject.maxMessages', n) },
        }),

        h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
          h('div', { style: { width: 200 } },
            h('label', { style: S.label }, '外层标签名'),
            h('input', {
              style: S.input,
              value: d.inject.blockName,
              placeholder: 'vcprag-recall',
              onChange: function (e) { patch('inject.blockName', e.target.value) },
            })),
          h('div', { style: { width: 120 } },
            h('label', { style: S.label }, '注入顺序'),
            h('input', {
              style: S.input,
              type: 'number',
              value: d.inject.order,
              onChange: function (e) { patch('inject.order', Number(e.target.value)) },
            }))),

        h('label', { style: S.label }, '召回块首行说明'),
        h('input', {
          style: Object.assign({}, S.input, { marginBottom: 8 }),
          value: d.inject.header,
          onChange: function (e) { patch('inject.header', e.target.value) },
        }),

        h('label', { style: S.label }, '免责声明（避免模型把记忆当指令执行）'),
        h('input', {
          style: Object.assign({}, S.input, { marginBottom: 8 }),
          value: d.inject.disclaimer,
          onChange: function (e) { patch('inject.disclaimer', e.target.value) },
        }),

        h('label', { style: S.label }, '单条命中前缀（可用 {n} {date} {title}）'),
        h('input', {
          style: Object.assign({}, S.input, { marginBottom: 12 }),
          value: d.inject.itemPrefix,
          onChange: function (e) { patch('inject.itemPrefix', e.target.value) },
        }),

        h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '常驻记忆 section 标题'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          h('div', { style: { flex: 2, minWidth: 180 } },
            h('label', { style: S.label }, '区块标题'),
            h('input', {
              style: S.input,
              value: d.runtime.title,
              onChange: function (e) { patch('runtime.title', e.target.value) },
            })),
          h('div', { style: { flex: 1, minWidth: 120 } },
            h('label', { style: S.label }, '「必须遵守」标题'),
            h('input', {
              style: S.input,
              value: d.runtime.criticalTitle,
              onChange: function (e) { patch('runtime.criticalTitle', e.target.value) },
            })),
          h('div', { style: { flex: 1, minWidth: 120 } },
            h('label', { style: S.label }, '「一般事实」标题'),
            h('input', {
              style: S.input,
              value: d.runtime.normalTitle,
              onChange: function (e) { patch('runtime.normalTitle', e.target.value) },
            }))),
        h('label', { style: S.label }, '引导语'),
        h('input', {
          style: Object.assign({}, S.input, { marginBottom: 8 }),
          value: d.runtime.intro,
          onChange: function (e) { patch('runtime.intro', e.target.value) },
        }),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('input', {
            type: 'checkbox',
            checked: d.runtime.toolGuidance,
            onChange: function (e) { patch('runtime.toolGuidance', e.target.checked) },
          }),
          h('span', null, '附带 6 个工具的用法说明')),
        h('div', { style: S.hint },
          '这些文案改动会让 system prompt 变化 → 触发一次缓存前缀重建。改完建议开新会话。')
      )

      // ---- H. 日记写作规范（模板注入）----
      var templateCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: 10 } }, 'H. 日记写作规范（注入 system prompt）'),
        h('div', { style: Object.assign({}, S.hint, { marginBottom: 10 }) },
          '这段提示词决定日记质量，是全插件杠杆最大的一处。留空则用内置模板。'
          + '模板作为 section 常驻注入，逐字节恒定 → 不破坏前缀缓存。'),
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('input', {
              type: 'checkbox',
              checked: !!d.diary.templateEnabled,
              onChange: function (e) {
                patch('diary.templateEnabled', e.target.checked)
                saveTemplate(undefined, e.target.checked)
              },
            }),
            h('span', null, '注入日记规范')),
          h('div', { style: { width: 120 } },
            h('input', {
              style: S.input,
              type: 'number',
              value: d.diary.templateOrder,
              title: '注入顺序',
              onChange: function (e) { patch('diary.templateOrder', Number(e.target.value)) },
            })),
          s.template
            ? h('span', { style: S.badge(s.template.isCustom ? 'info' : 'muted') },
              s.template.isCustom ? '自定义模板' : '内置模板')
            : null),
        h('textarea', {
          style: Object.assign({}, S.input, {
            height: 360,
            resize: 'vertical',
            fontFamily: TOKEN.mono,
            fontSize: 12,
            lineHeight: '18px',
          }),
          value: s.templateText,
          placeholder: '留空 = 使用内置模板',
          onChange: function (e) { setTemplateState({ template: e.target.value }) },
        }),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
          h('button', {
            style: S.button(true),
            onClick: function () { saveTemplate(s.templateText, undefined) },
          }, '保存模板'),
          h('button', {
            style: S.button(false),
            onClick: function () {
              var builtIn = (s.template && s.template.builtIn) || ''
              setTemplateState({ template: builtIn })
            },
          }, '填入内置模板'),
          h('button', {
            style: S.button(false),
            onClick: function () {
              setTemplateState({ template: '' })
              saveTemplate('', undefined)
            },
          }, '清空（回退内置）'),
          h('span', { style: S.hint }, '改动需重启 DSH 才生效'))
      )

      // ---- I. 语义写入（正文结构化块）----
      var semantic = d.diary.semantic || {}
      var semanticCard = h('div', { style: S.card },
        h('div', { style: { fontWeight: 600, marginBottom: 10 } }, 'I. 语义写入（在回复正文里写日记块）'),
        h('div', { style: Object.assign({}, S.hint, { marginBottom: 10 }) },
          '开一条不经过工具往返的写入通道：模型直接在正文里落一段 '
          + h('code', { style: S.code }, '<<<' + (semantic.blockName || 'DailyNote') + 'Start>>> … <<<' + (semantic.blockName || 'DailyNote') + 'End>>>')
          + '，系统解析后写盘。与工具调用并存，默认优先 —— 省一轮上下文，且块本身可读可校对。'),

        h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('input', {
              type: 'checkbox',
              checked: semantic.enabled !== false,
              onChange: function (e) { patch('diary.semantic.enabled', e.target.checked) },
            }),
            h('span', null, '启用语义写入')),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('input', {
              type: 'checkbox',
              checked: semantic.allowUpdate !== false,
              onChange: function (e) { patch('diary.semantic.allowUpdate', e.target.checked) },
            }),
            h('span', null, '允许 update 改已有日记')),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('input', {
              type: 'checkbox',
              checked: semantic.stripFromDisplay !== false,
              onChange: function (e) { patch('diary.semantic.stripFromDisplay', e.target.checked) },
            }),
            h('span', null, '气泡里隐藏块'))),

        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
          h('div', { style: { flex: 1, minWidth: 160 } },
            h('label', { style: S.label }, '块标记名'),
            h('input', {
              style: S.input,
              value: semantic.blockName || 'DailyNote',
              placeholder: 'DailyNote',
              onChange: function (e) { patch('diary.semantic.blockName', e.target.value) },
            })),
          h('div', { style: { width: 160 } },
            h('label', { style: S.label }, 'update 锚点最短字数'),
            h('input', {
              style: S.input,
              type: 'number',
              min: 5,
              max: 500,
              value: semantic.updateMinTarget === undefined ? 15 : semantic.updateMinTarget,
              onChange: function (e) { patch('diary.semantic.updateMinTarget', Number(e.target.value)) },
            }))),

        h('div', { style: Object.assign({}, S.hint, { marginBottom: 6 }) },
          '安全阀：update 的 target 太短会命中多处，替换就成了随机破坏。'
          + '15 字是稳妥下限，调低请自行承担风险。'),

        // ---- 自检：贴一段正文，验证一下解析结果 ----
        h('div', { style: { fontWeight: 600, margin: '12px 0 6px' } }, '自检：贴一段正文看解析结果'),
        h('textarea', {
          style: Object.assign({}, S.input, {
            height: 130,
            resize: 'vertical',
            fontFamily: TOKEN.mono,
            fontSize: 12,
            lineHeight: '18px',
          }),
          value: s.previewText,
          placeholder: '把带块的回复正文贴进来，下面会显示系统会解析成什么。',
          onChange: function (e) { setPreviewState({ previewText: e.target.value }) },
        }),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
          h('button', {
            style: S.button(true),
            onClick: function () { runPreview(s.previewText) },
          }, '解析看看'),
          s.preview
            ? h('span', { style: S.badge(s.preview.found > 0 ? 'ok' : 'warn') },
              '解析到 ' + s.preview.found + ' 个块')
            : null),
        s.preview
          ? h('div', { style: Object.assign({}, S.mono, { marginTop: 8 }) },
            (s.preview.rows || []).map(function (row, i) {
              return h('div', {
                key: 'pv' + i,
                style: {
                  padding: '6px 8px',
                  marginBottom: 6,
                  borderRadius: 4,
                  background: TOKEN.surface2,
                  borderLeft: '3px solid ' + (row.ok ? TOKEN.success : TOKEN.error),
                },
              },
                h('div', null, '#' + (i + 1) + ' command=' + (row.command || '(无)')
                  + (row.title ? ' · title=' + row.title : '')
                  + (row.bodyChars ? ' · 正文 ' + row.bodyChars + ' 字' : '')),
                row.target ? h('div', { style: { color: TOKEN.label2 } }, 'target(' + row.target.length + ' 字): ' + row.target.slice(0, 60)) : null,
                row.tags && row.tags.length ? h('div', { style: { color: TOKEN.label2 } }, 'tags: ' + row.tags.join(', ')) : null,
                (row.errors || []).length ? h('div', { style: { color: TOKEN.error } }, '✗ ' + row.errors.join(' / ')) : null,
                (row.problems || []).length ? h('div', { style: { color: TOKEN.label2 } }, '⚠ ' + row.problems.join(' / ')) : null)
            }),
            s.preview.hint ? h('div', { style: { color: TOKEN.label2, marginTop: 4 } }, s.preview.hint) : null)
          : null
      )

      // ---- 底部保存栏 ----
      var footer = h('div', {
        style: {
          position: 'sticky',
          bottom: 0,
          background: TOKEN.surface,
          borderTop: '0.5px solid ' + TOKEN.border,
          padding: '10px 0',
          marginTop: 4,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
        },
      },
        h('button', { style: S.button(true), onClick: function () { save(false) } }, '保存配置'),
        h('button', { style: S.button(false), onClick: load }, '重新加载'),
        h('button', {
          style: S.button(false),
          onClick: function () { merge({ draft: JSON.parse(JSON.stringify(s.data.defaults)) }) },
        }, '恢复默认值'),
        s.msg ? h('span', { style: { fontSize: 12, color: TOKEN.brand } }, s.msg) : null
      )

      var body = h('div', null,
        channelCard, recallCard, freezeCard, diaryCard, semanticCard, injectCard,
        runtimeCard, aliasCard, templateCard, footer)

      if (s.dialog === null) return body

      return h('div', null, body,
        h(ConfirmDialog, {
          title: s.dialog.title,
          message: s.dialog.message,
          consequences: s.dialog.consequences,
          actions: s.dialog.actions,
          onChoose: onDialogChoose,
        }))
    }

    // ================= 顶栏状态条 =================

    function StatusBar() {
      var st = React.useState(null)
      var s = st[0]
      var set = st[1]

      React.useEffect(function () {
        function refresh() {
          get('/state').then(function (r) { if (r.ok) set(r) })
        }
        refresh()
        var timer = setInterval(refresh, 20000)
        return function () { clearInterval(timer) }
      }, [])

      if (s === null) {
        return h('div', { style: { fontSize: 11, color: TOKEN.label2, marginBottom: 10 } }, '读取状态…')
      }

      var idx = s.index
      var tone = idx.hybridReady ? 'ok' : (idx.compatible && idx.compatible.fatal ? 'err' : 'warn')
      var label = idx.hybridReady
        ? '混合召回'
        : idx.vectorsIndexed
          ? '仅关键词（向量未参与查询）'
          : '仅关键词'

      // 只用日记时 activeDocs 恒为 0（没有 .md 语料），直接显示它会让用户
      // 以为「一篇都没有」—— 这正是踩过的「共 0 篇 / 一直读取状态」。
      // 总数取索引里实际文档数，再分别标注两层各多少。
      var totalDocs = idx.docCount || 0
      var diaryDocs = s.corpus.diaryDocs || 0
      var corpusDocs = s.corpus.activeDocs || 0

      return h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 } },
        h('span', { style: S.badge(tone) }, label),
        h('span', { style: S.badge('muted') }, '文档 ' + totalDocs + ' 篇'),
        diaryDocs > 0 ? h('span', { style: S.badge('muted') }, '日记 ' + diaryDocs) : null,
        corpusDocs > 0 ? h('span', { style: S.badge('muted') }, '语料 ' + corpusDocs) : null,
        h('span', { style: S.badge('muted') }, 'chunk ' + idx.chunkCount),
        h('span', { style: S.badge('muted') }, 'runtime ' + s.corpus.runtimeCount + ' 条'),
        h('span', { style: S.badge('muted') }, '已向量化 ' + idx.vectorized),
        idx.compatible && idx.compatible.ok === false && idx.compatible.reason
          ? h('span', { style: S.badge('warn') }, idx.compatible.reason)
          : null
      )
    }

    // ================= 主面板 =================

    var TABS = [
      { id: 'library', label: '记忆库', component: LibraryTab },
      { id: 'debug', label: '召回调试', component: DebugTab },
      { id: 'index', label: '索引', component: IndexTab },
      { id: 'settings', label: '设置', component: SettingsTab },
    ]

    function Panel() {
      var st = React.useState('library')
      var active = st[0]
      var setActive = st[1]

      var current = TABS[0]
      for (var i = 0; i < TABS.length; i += 1) {
        if (TABS[i].id === active) current = TABS[i]
      }

      var header = h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 } },
        h('div', { style: { fontSize: 15, fontWeight: 700 } }, '记忆召回'),
        h('div', { style: { fontSize: 11, color: TOKEN.label2 } }, 'vcprag'))

      var tabs = h('div', { style: S.tabs },
        TABS.map(function (tab) {
          return h('button', {
            key: tab.id,
            style: S.tab(active === tab.id),
            onClick: function () { setActive(tab.id) },
          }, tab.label)
        }))

      return h('div', { style: S.page },
        header,
        h(StatusBar, null),
        tabs,
        h(current.component, { key: active }))
    }

    // ---- DSH client 插件契约：必须是 { name, inject, apply } ----
    // 只 exports 组件是没用的 —— DSH 只认 slots 注册出来的面板。
    // 旧版就是漏了这一步，所以设置页里根本找不到入口。
    exports.name = 'vcprag'
    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      var slots = ctx && (ctx.get ? ctx.get('slots') : ctx.slots)
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        console.warn('[vcprag] slots 服务不可用，设置页未挂载')
        return
      }
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'vcprag', order: 70, label: '记忆召回' },
          Panel,
        )
      })
    }

    // 注意：不要额外导出 `default` / `Panel`。
    // DSH 的 bundle loader 会优先把 `default` 当作 ESM 默认导出，
    // 于是把 React 组件当插件调用 → 返回 React element → 激活失败
    // （web boot: "@local/dsh-vcprag: failed"）。
    // 只导出 name / inject / apply 三件套。
    return module.exports
  },
})
