// Radio Browser submissions use ISO subdivision codes, modern spellings and older romanizations.
const divisions = [
  ['北京','beijing','BJ','Peking 京津冀之声'], ['天津','tianjin','TJ','Tientsin'],
  ['上海','shanghai','SH',''], ['重庆','chongqing','CQ','Chungking 梁平 南川 万盛'],
  ['河北','hebei','HE','Hopei 石家庄 唐山 邯郸 保定 沧州 邢台 廊坊 张家口 衡水 秦皇岛 承德 霸州 磁县 定州 固安 涞水 枣强'],
  ['山西','shanxi','SX','Shansi 太原 大同 临汾 运城 长治 晋城 晋中 阳泉 吕梁 浑源'],
  ['辽宁','liaoning','LN','Dalian 大连 沈阳 鞍山 辽阳 抚顺 丹东 锦州 营口 盘锦 本溪 盘山'],
  ['吉林','jilin','JL','长春 延边 延吉 四平 通化 白城 松原 白山 辽源'],
  ['黑龙江','heilongjiang','HL','Amur-River 哈尔滨 齐齐哈尔 大庆 牡丹江 佳木斯 伊春'],
  ['江苏','jiangsu','JS','Kiangsu 南京 苏州 无锡 常州 南通 徐州 连云港 盐城 扬州 泰州 镇江 淮安 宿迁 江阴 中国药科大学'],
  ['浙江','zhejiang','ZJ','Chekiang 杭州 宁波 温州 绍兴 金华 台州 嘉兴 湖州 衢州 丽水 舟山 上虞 龙游 黄岩'],
  ['安徽','anhui','AH','Anhwei 合肥 芜湖 蚌埠 阜阳 安庆 宣城 宿州 亳州 滁州 固镇 淮北 黄山 铜陵'],
  ['福建','fujian','FJ','Fukien 福州 厦门 泉州 莆田 三明 龙岩 宁德 漳州 南平 集美 平潭 中国华艺'],
  ['江西','jiangxi','JX','Kiangsi 南昌 九江 赣州 新余 吉安 鹰潭 景德镇 抚州'],
  ['山东','shandong','SD','Shantung 济南 青岛 淄博 安丘 烟台 临沂 潍坊 东营 泰安 枣庄 威海 菏泽 济宁 德州 滨州 广饶 利津 庆云 山亭 滕州 周村 淄川 邹平'],
  ['河南','henan','HA','Honan 郑州 洛阳 南阳 开封 商丘 安阳 新乡 焦作 信阳 许昌 平顶山 驻马店 濮阳 清丰 三门峡'],
  ['湖北','hubei','HB','Hupei 武汉 宜昌 荆州 襄阳 十堰 恩施 黄石 黄冈 孝感 江陵 襄州 孝昌'],
  ['湖南','hunan','HN','长沙 株洲 湘潭 衡阳 岳阳 常德 郴州 怀化 邵阳 永州 湘乡'],
  ['广东','guangdong','GD','Kwangtung Guangzhou 广州 深圳 珠海 汕头 中山 台山 东莞 佛山 江门 揭阳 肇庆 湛江 梅州 惠州 茂名 河源 潮州 汕尾 佛冈 化州 开平'],
  ['海南','hainan','HI','海口 三亚'], ['四川','sichuan','SC','Szechuan 成都 绵阳 达州 宜宾 泸州 德阳 甘孜 凉山 阿坝 乐山 广元 南充 攀枝花 大竹 郫都 雅安'],
  ['贵州','guizhou','GZ','Kweichow 贵阳 遵义 六盘水 毕节 安顺 黔东南 黔西南'],
  ['云南','yunnan','YN','昆明 曲靖 普洱 丽江 玉溪 大理 红河 西双版纳 保山 楚雄 昭通'],
  ['陕西','shaanxi','SN','Shensi 西安 咸阳 宝鸡 榆林 延安 汉中 渭南'],
  ['甘肃','gansu','GS','Kansu 兰州 天水 酒泉 张掖 金昌 甘南 武威 白银'],
  ['青海','qinghai','QH','Tsinghai 西宁 海东 格尔木'],
  ['内蒙古','neimenggu','NM','Inner-Mongolia 呼和浩特 包头 鄂尔多斯 呼伦贝尔 赤峰 通辽 阿拉善 锡林郭勒'],
  ['广西','guangxi','GX','Kwangsi 南宁 柳州 桂林 北海 玉林 梧州 百色 贵港'],
  ['西藏','xizang','XZ','Tibet 拉萨 昌都 日喀则 林芝'], ['宁夏','ningxia','NX','Ningsia 银川 吴忠 固原'],
  ['新疆','xinjiang','XJ','Sinkiang 乌鲁木齐 喀什 伊犁 阿克苏 克拉玛依 昌吉 哈密 阿拉尔'],
]
export const mainlandRegions = Object.fromEntries([...divisions.map(([region, slug]) => [region, slug]),
  ['全国','national'], ['大陆其他','mainland-other']])
const stateNames = new Map()
const namePrefixes = []
for (const [region, slug, iso, aliases] of divisions) {
  for (const alias of [region, slug, 'CN-' + iso, ...aliases.split(' ').filter(Boolean)]) {
    stateNames.set(alias.toLowerCase().replaceAll('-', ' '), region)
    if (/^\p{Script=Han}/u.test(alias)) namePrefixes.push([alias, region])
  }
}
export function mainlandRegion(name, state = '', iso = '') {
  if (/^(?:CNR[-\s]?\d|CRI\b|CGTN\s*RADIO|CHINA\s*PLUS$|CMG环球资讯广播|中国国际广播电台|中央人民广播电台|央广)/i.test(name) &&
      !namePrefixes.some(([prefix]) => name.includes(prefix))) return '全国'
  // 部分目录名以频率或英文品牌开头，正式台名排在后面。
  const embedded = [['宣化区融媒体中心', '河北'], ['沙湾人民广播电台', '新疆'], ['江阴人民广播电台', '江苏'],
    ['浑源人民广播电台', '山西'], ['永安广播电视台', '福建'], ['河南网络电台', '河南']]
  for (const [station, region] of embedded) if (name.includes(station)) return region
  if (/^SHANDONG\s*RGD/i.test(name)) return '山东'
  for (const [prefix, region] of namePrefixes) if (name.startsWith(prefix)) return region
  const text = String(state).toLowerCase().trim().replace(/(?: sheng| province| direct administered municipality| zhuangzu zizhiqu|省|市)$/, '')
  return stateNames.get(String(iso || '').toLowerCase().replace('-', ' ')) || stateNames.get(text) || '大陆其他'
}
