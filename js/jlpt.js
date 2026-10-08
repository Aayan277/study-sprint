// Optional starter decks: the JLPT N5 and N4 kanji, copied from Kanji Sprint.
// They are only added when you tap 'Add' under Starter decks on the Decks tab.
// One kanji per line: kanji | meanings (separated by ;) | readings (separated by ,) | category code

const CATEGORIES = { n: 'numbers & time', p: 'people & body', w: 'nature & directions', t: 'places & things', a: 'ideas & school', d: 'describing words', v: 'verbs' };

const RAW = {
  N5: `一|one|いち,ひと(つ)|n
二|two|に,ふた(つ)|n
三|three|さん,みっ(つ)|n
四|four|よん,し,よっ(つ)|n
五|five|ご,いつ(つ)|n
六|six|ろく,むっ(つ)|n
七|seven|なな,しち|n
八|eight|はち,やっ(つ)|n
九|nine|きゅう,く,ここの(つ)|n
十|ten|じゅう,とお|n
百|hundred|ひゃく|n
千|thousand|せん,ち|n
万|ten thousand|まん,ばん|n
円|yen;circle|えん,まる(い)|n
日|day;sun|ひ,にち,び,か|n
月|month;moon|つき,げつ,がつ|n
年|year|ねん,とし|n
時|time;hour;o'clock|じ,とき|n
分|minute;part;understand|ふん,ぶん,わ(かる)|n
半|half|はん|n
週|week|しゅう|n
今|now|いま,こん|n
午|noon|ご|n
前|before;front|まえ,ぜん|n
後|after;behind;later|あと,ご,うし(ろ),のち|n
毎|every|まい|n
何|what|なに,なん|n
先|ahead;previous|せん,さき|n
間|interval;between;space|あいだ,かん,ま|n
人|person|ひと,じん,にん|p
男|man;male|おとこ,だん|p
女|woman;female|おんな,じょ|p
子|child|こ,し|p
父|father|ちち,ふ|p
母|mother|はは,ぼ|p
友|friend|とも,ゆう|p
生|life;birth;raw|せい,い(きる),う(まれる),なま|p
名|name|な,めい|p
口|mouth|くち,こう|p
目|eye|め,もく|p
耳|ear|みみ,じ|p
手|hand|て,しゅ|p
足|foot;leg;enough|あし,そく,た(りる)|p
火|fire|ひ,か|w
水|water|みず,すい|w
木|tree;wood|き,もく,ぼく|w
金|gold;money|かね,きん|w
土|earth;soil|つち,ど|w
山|mountain|やま,さん|w
川|river|かわ,せん|w
天|heaven;sky|てん,あま|w
雨|rain|あめ,う|w
花|flower|はな,か|w
空|sky;empty|そら,くう,あ(く)|w
上|up;above|うえ,じょう,あ(がる)|w
下|down;below|した,か,くだ(さい),さ(がる)|w
中|middle;inside|なか,ちゅう|w
外|outside|そと,がい|w
右|right|みぎ,う,ゆう|w
左|left|ひだり,さ|w
東|east|ひがし,とう|w
西|west|にし,せい,さい|w
南|south|みなみ,なん|w
北|north|きた,ほく|w
学|study;learning|がく,まな(ぶ)|t
校|school|こう|t
国|country|くに,こく|t
車|car;vehicle|くるま,しゃ|t
電|electricity|でん|t
道|road;way|みち,どう|t
駅|station|えき|t
店|shop;store|みせ,てん|t
社|company;shrine|しゃ,やしろ|t
語|language;word|ご,かた(る)|t
本|book;origin|ほん,もと|t
大|big|おお(きい),だい,たい|d
小|small|ちい(さい),しょう,こ|d
長|long;chief|なが(い),ちょう|d
高|tall;expensive|たか(い),こう|d
安|cheap;peaceful|やす(い),あん|d
新|new|あたら(しい),しん|d
古|old|ふる(い),こ|d
白|white|しろ(い),はく|d
多|many;much|おお(い),た|d
少|few;a little|すく(ない),すこ(し),しょう|d
気|spirit;energy;mind|き,け|d
見|to see;to look|み(る),けん|v
行|to go|い(く),こう,ぎょう|v
来|to come|く(る),らい,き(ます)|v
食|to eat;food|た(べる),しょく|v
飲|to drink|の(む),いん|v
言|to say|い(う),げん,ごん|v
話|to talk;story|はな(す),はなし,わ|v
読|to read|よ(む),どく|v
書|to write|か(く),しょ|v
聞|to hear;to listen;to ask|き(く),ぶん|v
買|to buy|か(う),ばい|v
休|to rest;holiday|やす(む),きゅう|v
出|to go out;to exit|で(る),だ(す),しゅつ|v
入|to enter|はい(る),い(れる),にゅう|v
立|to stand|た(つ),りつ|v
会|to meet|あ(う),かい|v`,
  N4: `悪|bad;evil|わる(い),あく|d
暗|dark|くら(い),あん|d
医|doctor;medicine|い|p
意|meaning;mind;intention|い|a
以|compared to;from;by means of|い|a
引|to pull|ひ(く),いん|v
院|institution|いん|t
員|member;employee|いん|p
運|to carry;luck|はこ(ぶ),うん|v
英|English;England;excellent|えい|a
映|to reflect;to project|うつ(る),えい|v
遠|far|とお(い),えん|d
屋|roof;shop;dealer|や,おく|t
音|sound|おと,おん,ね|t
歌|song;to sing|うた,うた(う),か|v
夏|summer|なつ,か|n
家|house;home|いえ,うち,か,や|t
画|picture;stroke|が,かく|a
海|sea;ocean|うみ,かい|w
回|times;to turn around|かい,まわ(る)|n
開|to open|あ(ける),ひら(く),かい|v
界|world;boundary|かい|a
楽|fun;music;comfort|たの(しい),がく,らく|d
館|building;hall|かん,やかた|t
漢|China;Han|かん|a
寒|cold|さむ(い),かん|d
顔|face|かお,がん|p
帰|to return home|かえ(る),き|v
起|to wake up;to get up|お(きる),き|v
究|research|きゅう,きわ(める)|a
急|hurry;sudden|いそ(ぐ),きゅう|d
牛|cow;cattle|うし,ぎゅう|w
去|past;to leave|さ(る),きょ,こ|n
強|strong|つよ(い),きょう,ごう|d
教|to teach|おし(える),きょう|v
京|capital|きょう,けい|t
業|business;industry|ぎょう,わざ|a
近|near;close|ちか(い),きん|d
銀|silver|ぎん|t
区|ward;district|く|t
計|to measure;plan|はか(る),けい|a
兄|older brother|あに,きょう,けい|p
軽|light;not heavy|かる(い),けい|d
犬|dog|いぬ,けん|w
研|to sharpen;to study|と(ぐ),けん|a
県|prefecture|けん|t
建|to build|た(てる),けん|v
験|test;effect|けん,げん|a
元|origin;former|もと,げん,がん|a
工|craft;construction|こう,く|a
広|wide;spacious|ひろ(い),こう|d
考|to think;to consider|かんが(える),こう|v
光|light;ray|ひかり,ひか(る),こう|w
好|to like;fond|す(き),こう|d
合|to fit;to match|あ(う),ごう,がっ|v
黒|black|くろ(い),こく|d
菜|vegetable;greens|な,さい|w
作|to make|つく(る),さく,さ|v
産|to give birth;products|う(む),さん|a
紙|paper|かみ,し|t
思|to think|おも(う),し|v
姉|older sister|あね,し|p
止|to stop|と(まる),と(める),し|v
市|city;market|し,いち|t
仕|to serve;to do|つか(える),し|v
死|to die;death|し(ぬ),し|v
使|to use|つか(う),し|v
始|to begin;to start|はじ(める),はじ(まる),し|v
試|to test;to try|ため(す),こころ(みる),し|a
私|I;private|わたし,わたくし,し|p
字|character;letter|じ,あざ|a
自|oneself|じ,し,みずか(ら)|p
事|thing;matter|こと,じ|a
持|to hold;to have|も(つ),じ|v
室|room|しつ,むろ|t
質|quality;question|しつ,しち|a
写|to copy;to photograph|うつ(す),しゃ|v
者|someone;person who|もの,しゃ|p
借|to borrow|か(りる),しゃく|v
弱|weak|よわ(い),じゃく|d
首|neck|くび,しゅ|p
主|master;main|おも,ぬし,しゅ|a
秋|autumn;fall|あき,しゅう|n
集|to gather;to collect|あつ(める),あつ(まる),しゅう|v
習|to learn|なら(う),しゅう|v
終|to end;to finish|お(わる),しゅう|v
住|to live;to reside|す(む),じゅう|v
重|heavy|おも(い),じゅう,ちょう,え|d
春|spring|はる,しゅん|n
所|place|ところ,しょ|t
暑|hot;hot weather|あつ(い),しょ|d
場|place;location|ば,じょう|t
乗|to ride;to board|の(る),じょう|v
色|color|いろ,しょく|d
森|forest|もり,しん|w
心|heart;mind|こころ,しん|p
親|parent;intimate|おや,した(しい),しん|p
真|true;real|ま,しん|a
進|to advance;to proceed|すす(む),しん|v
図|map;drawing|ず,と,はか(る)|a
青|blue|あお(い),せい|d
正|correct;right|ただ(しい),せい,しょう|a
声|voice|こえ,せい|p
世|world;generation|よ,せ,せい|a
赤|red|あか(い),せき|d
夕|evening|ゆう|n
切|to cut|き(る),せつ|v
説|to explain;theory|と(く),せつ|a
洗|to wash|あら(う),せん|v
早|early;fast|はや(い),そう|d
走|to run|はし(る),そう|v
送|to send|おく(る),そう|v
族|family;tribe|ぞく|p
村|village|むら,そん|t
体|body|からだ,たい|p
太|fat;thick|ふと(い),たい|d
待|to wait|ま(つ),たい|v
貸|to lend|か(す),たい|v
台|stand;platform|だい,たい|t
代|generation;fee;to replace|か(わる),だい,よ|a
題|topic;title|だい|a
短|short|みじか(い),たん|d
知|to know|し(る),ち|v
地|ground;earth|ち,じ|w
池|pond|いけ,ち|w
茶|tea|ちゃ,さ|t
着|to wear;to arrive|き(る),つ(く),ちゃく|v
昼|daytime;noon|ひる,ちゅう|n
注|to pour;to note|そそ(ぐ),ちゅう|v
町|town|まち,ちょう|t
鳥|bird|とり,ちょう|w
朝|morning|あさ,ちょう|n
通|to pass through;to commute|とお(る),かよ(う),つう|v
弟|younger brother|おとうと,だい,てい|p
低|low|ひく(い),てい|d
転|to roll;to turn over|ころ(ぶ),てん|v
田|rice field|た,でん|w
都|capital;metropolis|と,みやこ,つ|t
度|degree;times|ど,たび|n
答|answer;to reply|こた(える),とう|a
冬|winter|ふゆ,とう|n
頭|head|あたま,とう,ず|p
同|same|おな(じ),どう|d
動|to move|うご(く),どう|v
堂|hall|どう|t
働|to work|はたら(く),どう|v
特|special|とく|d
肉|meat|にく|t
売|to sell|う(る),ばい|v
発|to depart;to emit|はつ,ほつ|v
飯|meal;cooked rice|めし,はん|t
病|illness;sick|やまい,びょう|p
品|goods;article|しな,ひん|a
不|not;un-|ふ,ぶ|a
風|wind;style|かぜ,ふう|w
服|clothes|ふく|t
物|thing;object|もの,ぶつ,もつ|a
文|sentence;writing|ぶん,もん,ふみ|a
別|separate;different|わか(れる),べつ|d
勉|effort;to study hard|べん|a
歩|to walk|ある(く),ほ|v
方|direction;way;person (polite)|かた,ほう|a
妹|younger sister|いもうと,まい|p
味|taste;flavor|あじ,み|d
民|people;nation|たみ,みん|a
明|bright;clear|あか(るい),めい,みょう|d
門|gate|かど,もん|t
問|question;problem|と(う),もん|a
夜|night|よる,や|n
野|field;plain|の,や|w
薬|medicine;drug|くすり,やく|t
有|to have;to exist|あ(る),ゆう,う|v
曜|day of the week|よう|n
用|use;business|もち(いる),よう|a
洋|ocean;Western|よう|w
理|reason;logic|り|a
旅|trip;travel|たび,りょ|t
料|fee;materials|りょう|a
力|power;strength|ちから,りょく,りき|p
林|grove;woods|はやし,りん|w`
};

export const STARTER_DECKS = [
  { key: 'jlpt-n5', level: 'N5', name: 'JLPT N5 Kanji', course: 'JLPT N5', color: '#E5484D' },
  { key: 'jlpt-n4', level: 'N4', name: 'JLPT N4 Kanji', course: 'JLPT N4', color: '#8E4EC6' }
];

// Cards for one level. The back lists the meanings and then the readings, separated by ; and /,
// so typing any one of them counts as right. e.g. 一 → 'one; いち / ひと(つ)'
export function starterCards(level) {
  return RAW[level].split('\n').map(line => {
    const [kanji, meanings, readings, cat] = line.split('|');
    return {
      front: kanji,
      back: `${meanings.split(';').join('; ')}; ${readings.split(',').join(' / ')}`,
      tags: [level, CATEGORIES[cat]].filter(Boolean)
    };
  });
}
