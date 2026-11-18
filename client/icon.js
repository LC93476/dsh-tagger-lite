// 侧边栏图标：需要 React，由门面注入（子模块不 import React）。

export function createIcon({ React }) {
  const h = React.createElement
function PanelIcon() {
  return h('svg', {
    viewBox: '0 0 24 24',
    width: 18,
    height: 18,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
  },
    h('path', { key: 'a', d: 'M4 19l7.2-7.2' }),
    h('path', { key: 'b', d: 'M14.5 4.2l5.3 5.3' }),
    h('path', { key: 'c', d: 'M16.4 2.3l5.3 5.3-2.4 2.4-5.3-5.3z' }),
    h('path', { key: 'd', d: 'M11.2 8.1l4.7 4.7-2.1 2.1-4.7-4.7z' }),
  )
}
  return PanelIcon
}
