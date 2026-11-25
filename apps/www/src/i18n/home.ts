import { SITE_DESCRIPTION } from "../site";
import { CLAUDE_CHATGPT_SUBSCRIPTION_FAQ } from "../subscription-faq";
import type { Locale } from "./locales";

export const HOME_MODEL_PROVIDERS = [
  "Claude",
  "ChatGPT",
  "OpenRouter",
  "Grok",
  "Ollama",
  "LM Studio",
];

export const HOME_CHANNELS = [
  { id: "slack", name: "Slack", selfHosted: false, docsAnchor: "slack" },
  { id: "teams", name: "Microsoft Teams", selfHosted: false, docsAnchor: "microsoft-teams" },
  { id: "imessage", name: "iMessage & SMS", selfHosted: true, docsAnchor: "imessage-and-sms" },
  { id: "whatsapp", name: "WhatsApp", selfHosted: true, docsAnchor: "whatsapp" },
  { id: "telegram", name: "Telegram", selfHosted: true, docsAnchor: "telegram" },
] as const;

export const HOME_FEATURE_KINDS = ["apps", "teach", "memory", "triggers", "team", "call"] as const;
export type HomeFeatureKind = (typeof HOME_FEATURE_KINDS)[number];

export type HomeCopy = {
  title: string;
  description: string;
  ogImageAlt: string;
  availableLanguage: string;
  skipToContent: string;
  nav: {
    home: string;
    primary: string;
    menu: string;
    docs: string;
    github: string;
    getStarted: string;
  };
  hero: {
    eyebrow: string;
    heading: string;
    lead: string;
    getStarted: string;
    download: Record<"mac" | "windows" | "linux" | "ios" | "android", string>;
    viewOnGithub: string;
    setupWithAgent: string;
    copiedForAgent: string;
    copyFailed: string;
  };
  selfHost: {
    heading: string;
    copy: string;
    worksWith: string;
    mock: { weekdays: string; approval: string; approve: string; deny: string };
    features: Array<{ title: string; body: string }>;
  };
  platforms: {
    heading: string;
    web: string;
    desktop: string;
    mobile: string;
  };
  channels: {
    heading: string;
    copy: string;
    mock: { ask: string; reply: string };
  };
  features: {
    heading: string;
    items: Record<HomeFeatureKind, { title: string; body: string }>;
    mock: {
      calling: string;
      memory: string;
      memoryNotes: [string, string];
      triggers: [string, string, string];
      recording: string;
      skillSaved: string;
    };
  };
  faq: {
    heading: string;
    items: Array<{ question: string; answer: string }>;
  };
  openSource: {
    heading: string;
    copy: string;
    starOnGithub: string;
    readTheDocs: string;
    cloudTitle: string;
    cloudBadge: string;
  };
  cta: {
    heading: string;
    copy: string;
    openSourceValue: string;
    selfHostValue: string;
    stats: Array<{ value: "stars" | "license" | "openSource" | "selfHost"; label: string }>;
  };
  footer: {
    navLabel: string;
    languagesLabel: string;
    links: {
      docs: string;
      product: string;
      changelog: string;
      download: string;
    };
  };
};

const HOME_COPY: Record<Locale, HomeCopy> = {
  pl: {
    title: "Superbot | Otwarta alternatywa dla Grok Bot",
    description:
      "Superbot to otwarta alternatywa dla Grok Bot. Boty AI z własną pamięcią wykonują zadania na Twoim komputerze, z wybranym przez Ciebie modelem.",
    ogImageAlt: "Superbot. Twój zespół AI na Twoim komputerze, z Twoimi kluczami i modelem.",
    availableLanguage: "Polish",
    skipToContent: "Przejdź do treści",
    nav: {
      home: "Strona główna Superbot",
      primary: "Nawigacja główna",
      menu: "Menu",
      docs: "Dokumentacja",
      github: "GitHub",
      getStarted: "Zacznij",
    },
    hero: {
      eyebrow: "Otwarty kod źródłowy",
      heading: "Otwarta alternatywa dla Grok Bot pod Twoją kontrolą",
      lead: "Zleć botom zadanie. Śledź ich pracę z dowolnego urządzenia.",
      getStarted: "Zacznij",
      download: {
        mac: "Pobierz na macOS",
        windows: "Pobierz na Windows",
        linux: "Pobierz na Linux",
        ios: "Pobierz na iOS",
        android: "Pobierz na Androida",
      },
      viewOnGithub: "Zobacz na GitHubie",
      setupWithAgent: "Skonfiguruj ze swoim agentem",
      copiedForAgent: "Skopiowano dla agenta",
      copyFailed: "Nie udało się skopiować. Spróbuj ponownie.",
    },
    selfHost: {
      heading: "Na własnym serwerze",
      copy: "Uruchom Superbot na swoim komputerze i wybierz modele dla swoich botów.",
      worksWith: "Współpracuje z",
      mock: {
        weekdays: "W dni robocze o 9:00",
        approval: "Wymaga zatwierdzenia",
        approve: "Zatwierdź",
        deny: "Odrzuć",
      },
      features: [
        { title: "Twój model", body: "Wybierz inny model dla każdego bota." },
        {
          title: "Praca według harmonogramu",
          body: "Działa także wtedy, gdy Twój komputer jest wyłączony.",
        },
        { title: "Ty ustalasz granice", body: "Zdecyduj, które działania wymagają Twojej zgody." },
      ],
    },
    platforms: {
      heading: "Gdziekolwiek jesteś",
      web: "Przeglądarka",
      desktop: "Komputer",
      mobile: "Telefon",
    },
    channels: {
      heading: "Pisz do nich z dowolnego miejsca",
      copy: "Wspomnij bota na Slacku lub napisz do niego z telefonu.",
      mock: {
        ask: "do kogo trzeba się dziś odezwać?",
        reply: "Trzech potencjalnych klientów nie odpowiedziało w tym tygodniu. Szkice są w wątku.",
      },
    },
    features: {
      heading: "Rozmowa i działanie",
      items: {
        call: {
          title: "Połączenia i spotkania",
          body: "Bot dzwoni do Ciebie w aplikacji i dołącza do Zoom lub Google Meet, by sporządzić transkrypcję.",
        },
        apps: {
          title: "Pracuje w Twoich aplikacjach",
          body: "Połącz Gmail, GitHub, Notion i dowolny serwer MCP.",
        },
        memory: {
          title: "Pamięta",
          body: "Boty zapamiętują to, czego się uczą, i dzielą się wiedzą z zespołem.",
        },
        triggers: {
          title: "Sam zaczyna pracę",
          body: "Uruchamia go harmonogram, webhook, zdarzenie na GitHubie lub obserwowana zmiana.",
        },
        team: {
          title: "Przekazuje zadania",
          body: "Boty zlecają sobie pracę i współpracują w grupach.",
        },
        teach: {
          title: "Uczy się, obserwując",
          body: "Pokaż raz zadanie na komputerze bota. Zapisze kroki jako umiejętność.",
        },
      },
      mock: {
        calling: "Dzwonienie…",
        memory: "Pamięć",
        memoryNotes: ["Preferuje krótkie odpowiedzi", "Acme odnawia umowę w marcu"],
        triggers: ["W dni robocze o 9:00", "Nowe zgłoszenie na GitHubie", "Webhook"],
        recording: "Nagrywanie",
        skillSaved: "Zapisano jako umiejętność",
      },
    },
    faq: {
      heading: "Pytania i odpowiedzi",
      items: [
        {
          question: "Czy mogę używać subskrypcji Claude Pro/Max lub ChatGPT Plus/Pro?",
          answer:
            "Tak. Zaloguj się przez ChatGPT z odpowiednim planem. Aby używać Claude Pro lub Max, hostuj Superbot samodzielnie z kodu źródłowego tylko dla siebie i uruchamiaj je przez oficjalne Claude Code CLI zalogowane na Twoje konto. Możesz też połączyć klucz API. Szczegóły opisano na stronie Model subscriptions w dokumentacji.",
        },
        {
          question: "Czy mogę uruchomić model lokalnie?",
          answer:
            "Tak. Połącz bota z lokalnym serwerem zgodnym z OpenAI, np. Ollama lub LM Studio. Każdy bot może korzystać z innego modelu.",
        },
      ],
    },
    openSource: {
      heading: "Otwarty kod źródłowy",
      copy: "Licencja Apache-2.0. Uruchom Superbot i dostosuj kod do swoich potrzeb.",
      starOnGithub: "Dodaj gwiazdkę na GitHubie",
      readTheDocs: "Przeczytaj dokumentację",
      cloudTitle: "Chmura",
      cloudBadge: "Beta",
    },
    cta: {
      heading: "Poznaj swojego pierwszego bota",
      copy: "Powierz mu kolejne zadanie.",
      openSourceValue: "Otwarty kod",
      selfHostValue: "Własny serwer",
      stats: [
        { value: "stars", label: "Gwiazdki na GitHubie" },
        { value: "license", label: "Licencja" },
        { value: "openSource", label: "Wszystkie funkcje za darmo" },
        { value: "selfHost", label: "Twój komputer" },
      ],
    },
    footer: {
      navLabel: "Stopka",
      languagesLabel: "Język",
      links: {
        docs: "Dokumentacja",
        product: "Produkt",
        changelog: "Historia zmian",
        download: "Pobierz",
      },
    },
  },
  en: {
    title: "Superbot | Open source AI teammates that do real work",
    description: SITE_DESCRIPTION,
    ogImageAlt: "Superbot. AI teammates you actually own. Your keys, your model, your machine.",
    availableLanguage: "English",
    skipToContent: "Skip to content",
    nav: {
      home: "Superbot home",
      primary: "Primary",
      menu: "Menu",
      docs: "Docs",
      github: "GitHub",
      getStarted: "Get started",
    },
    hero: {
      eyebrow: "Open source",
      heading: "AI teammates that do real work, on your terms",
      lead: "Give your bots a job. Check in from any device.",
      getStarted: "Get started",
      download: {
        mac: "Download for macOS",
        windows: "Download for Windows",
        linux: "Download for Linux",
        ios: "Download for iOS",
        android: "Download for Android",
      },
      viewOnGithub: "View on GitHub",
      setupWithAgent: "Set up with your agent",
      copiedForAgent: "Copied for your agent",
      copyFailed: "Copy failed. Try again.",
    },
    selfHost: {
      heading: "Self-hosted",
      copy: "Your machine, your models, your control.",
      worksWith: "Works with",
      mock: {
        weekdays: "Weekdays at 9:00",
        approval: "Approval required",
        approve: "Approve",
        deny: "Deny",
      },
      features: [
        { title: "Your model", body: "Choose a different model for each bot." },
        { title: "Work on a schedule", body: "Keeps working while your computer is off." },
        { title: "You set the limits", body: "Decide which actions need your approval." },
      ],
    },
    platforms: {
      heading: "Wherever you are",
      web: "Web",
      desktop: "Desktop",
      mobile: "Mobile",
    },
    channels: {
      heading: "Message them anywhere",
      copy: "Mention a bot in Slack or text it from your phone.",
      mock: {
        ask: "who needs a follow-up today?",
        reply: "Three leads went quiet this week. Drafts are in the thread.",
      },
    },
    features: {
      heading: "More than chat",
      items: {
        call: {
          title: "Calls and meetings",
          body: "Your bot can call you in the app and join Zoom or Google Meet for a transcript.",
        },
        apps: {
          title: "Works where you work",
          body: "Connect GitHub, Gmail, Notion and any MCP server.",
        },
        memory: {
          title: "Remembers",
          body: "Bots keep what they learn and share it with the team.",
        },
        triggers: {
          title: "Wakes up on its own",
          body: "On a schedule, a webhook, a GitHub event, or a change it watches.",
        },
        team: {
          title: "Hands off work",
          body: "Bots delegate to each other and work together in groups.",
        },
        teach: {
          title: "Learns by watching",
          body: "Show a task once on its computer. It saves the steps as a skill.",
        },
      },
      mock: {
        calling: "Calling…",
        memory: "Memory",
        memoryNotes: ["Prefers short replies", "Acme renews in March"],
        triggers: ["Weekdays at 9:00", "New GitHub issue", "Webhook"],
        recording: "Recording",
        skillSaved: "Saved as a skill",
      },
    },
    faq: {
      heading: "FAQ",
      items: [
        CLAUDE_CHATGPT_SUBSCRIPTION_FAQ,
        {
          question: "Can I run a local model?",
          answer:
            "Yes. Point a bot at a local OpenAI-compatible server such as Ollama or LM Studio. Each bot can use a different model.",
        },
      ],
    },
    openSource: {
      heading: "Open source",
      copy: "Apache-2.0. Run it, change it, make it yours.",
      starOnGithub: "Star on GitHub",
      readTheDocs: "Read the docs",
      cloudTitle: "Cloud",
      cloudBadge: "Beta",
    },
    cta: {
      heading: "Meet your first bot",
      copy: "Hand over your next task.",
      openSourceValue: "Open source",
      selfHostValue: "Self-host",
      stats: [
        { value: "stars", label: "GitHub stars" },
        { value: "license", label: "License" },
        { value: "openSource", label: "Every feature, free" },
        { value: "selfHost", label: "Your machine" },
      ],
    },
    footer: {
      navLabel: "Footer",
      languagesLabel: "Language",
      links: {
        docs: "Docs",
        product: "Product",
        changelog: "Changelog",
        download: "Download",
      },
    },
  },
  de: {
    title: "Superbot | Open-Source-Alternative zu Grok Bot",
    description:
      "Superbot ist eine Open-Source-Alternative zu Grok Bot für persistente KI-Teamkollegen, die echte Arbeit erledigen. Deine Keys, dein Modell, deine Maschine.",
    ogImageAlt:
      "Superbot. KI-Teamkollegen, die dir wirklich gehören. Deine Keys, dein Modell, deine Maschine.",
    availableLanguage: "German",
    skipToContent: "Zum Inhalt springen",
    nav: {
      home: "Superbot-Startseite",
      primary: "Hauptnavigation",
      menu: "Menü",
      docs: "Docs",
      github: "GitHub",
      getStarted: "Loslegen",
    },
    hero: {
      eyebrow: "Open Source",
      heading: "Die Open-Source-Alternative zu Grok Bot, die dir wirklich gehört",
      lead: "Gib deinen Bots eine Aufgabe. Schau von jedem Gerät nach.",
      getStarted: "Loslegen",
      download: {
        mac: "Für macOS laden",
        windows: "Für Windows laden",
        linux: "Für Linux laden",
        ios: "Für iOS laden",
        android: "Für Android laden",
      },
      viewOnGithub: "Auf GitHub ansehen",
      setupWithAgent: "Mit deinem Agenten einrichten",
      copiedForAgent: "Für deinen Agenten kopiert",
      copyFailed: "Kopieren fehlgeschlagen. Erneut versuchen.",
    },
    selfHost: {
      heading: "Self-hosted",
      copy: "Deine Maschine, deine Modelle, deine Kontrolle.",
      worksWith: "Funktioniert mit",
      mock: {
        weekdays: "Mo–Fr um 9:00",
        approval: "Freigabe erforderlich",
        approve: "Genehmigen",
        deny: "Ablehnen",
      },
      features: [
        { title: "Dein Modell", body: "Wähle für jeden Bot ein anderes Modell." },
        {
          title: "Arbeitet nach Zeitplan",
          body: "Arbeitet weiter, auch wenn dein Computer aus ist.",
        },
        {
          title: "Du setzt die Grenzen",
          body: "Bestimme, welche Aktionen deine Freigabe brauchen.",
        },
      ],
    },
    platforms: {
      heading: "Überall, wo du bist",
      web: "Web",
      desktop: "Desktop",
      mobile: "Mobil",
    },
    channels: {
      heading: "Schreib ihnen überall",
      copy: "Erwähne einen Bot in Slack oder schreib ihm vom Handy.",
      mock: {
        ask: "wer braucht heute ein Follow-up?",
        reply: "Drei Leads sind diese Woche still geworden. Die Entwürfe sind im Thread.",
      },
    },
    features: {
      heading: "Mehr als Chat",
      items: {
        call: {
          title: "Anrufe und Meetings",
          body: "Dein Bot ruft dich in der App an und erstellt Transkripte für Zoom- oder Google-Meet-Termine.",
        },
        apps: {
          title: "Arbeitet in deinen Apps",
          body: "Verbinde Gmail, GitHub, Notion und jeden MCP-Server.",
        },
        memory: {
          title: "Merkt sich Dinge",
          body: "Bots behalten, was sie lernen, und teilen es mit dem Team.",
        },
        triggers: {
          title: "Wird von selbst aktiv",
          body: "Nach Zeitplan, per Webhook, bei GitHub-Events oder wenn sich etwas ändert.",
        },
        team: {
          title: "Gibt Arbeit ab",
          body: "Bots delegieren untereinander und arbeiten in Gruppen zusammen.",
        },
        teach: {
          title: "Lernt durch Zuschauen",
          body: "Zeig eine Aufgabe einmal auf seinem Computer. Er speichert die Schritte als Skill.",
        },
      },
      mock: {
        calling: "Ruft an…",
        memory: "Gedächtnis",
        memoryNotes: ["Mag kurze Antworten", "Acme verlängert im März"],
        triggers: ["Mo–Fr um 9:00", "Neues GitHub-Issue", "Webhook"],
        recording: "Aufnahme",
        skillSaved: "Als Skill gespeichert",
      },
    },
    faq: {
      heading: "FAQ",
      items: [
        {
          question: "Kann ich mein Claude Pro/Max- oder ChatGPT Plus/Pro-Abo nutzen?",
          answer:
            "Ja. Melde dich mit einem passenden Plan über ChatGPT an. Für Claude Pro oder Max hostest du Superbot aus dem Quellcode nur für dich selbst und betreibst es über die offizielle Claude Code CLI, angemeldet mit deinem Konto. Du kannst auch einen API-Schlüssel verbinden. Details findest du unter Model subscriptions in der Dokumentation.",
        },
        {
          question: "Kann ich ein lokales Modell nutzen?",
          answer:
            "Ja. Richte einen Bot auf einen lokalen OpenAI-kompatiblen Server wie Ollama oder LM Studio. Jeder Bot kann ein anderes Modell nutzen.",
        },
      ],
    },
    openSource: {
      heading: "Open Source",
      copy: "Apache-2.0. Selbst betreiben, ändern und anpassen.",
      starOnGithub: "Auf GitHub mit Stern markieren",
      readTheDocs: "Docs lesen",
      cloudTitle: "Cloud",
      cloudBadge: "Beta",
    },
    cta: {
      heading: "Triff deinen ersten Bot",
      copy: "Gib deine nächste Aufgabe ab.",
      openSourceValue: "Open Source",
      selfHostValue: "Self-host",
      stats: [
        { value: "stars", label: "GitHub Stars" },
        { value: "license", label: "Lizenz" },
        { value: "openSource", label: "Alle Funktionen, kostenlos" },
        { value: "selfHost", label: "Deine Maschine" },
      ],
    },
    footer: {
      navLabel: "Fußzeile",
      languagesLabel: "Sprache",
      links: {
        docs: "Dokumentation",
        product: "Produkt",
        changelog: "Änderungsprotokoll",
        download: "Download",
      },
    },
  },
  ko: {
    title: "Superbot | 오픈소스 Grok Bot 대안",
    description:
      "Superbot는 실제 업무를 수행하는 지속형 AI 팀원을 위한 오픈소스 Grok Bot 대안입니다. 키, 모델, 머신, 모두 당신 것.",
    ogImageAlt: "Superbot. 진짜로 내 것인 AI 팀원. 키, 모델, 머신, 모두 당신 것.",
    availableLanguage: "Korean",
    skipToContent: "본문으로 건너뛰기",
    nav: {
      home: "Superbot 홈",
      primary: "주 메뉴",
      menu: "메뉴",
      docs: "Docs",
      github: "GitHub",
      getStarted: "시작하기",
    },
    hero: {
      eyebrow: "오픈 소스",
      heading: "진짜로 내 것인 오픈소스 Grok Bot 대안",
      lead: "봇에게 일을 맡기세요. 어떤 기기에서든 확인하세요.",
      getStarted: "시작하기",
      download: {
        mac: "macOS용 다운로드",
        windows: "Windows용 다운로드",
        linux: "Linux용 다운로드",
        ios: "iOS용 다운로드",
        android: "Android용 다운로드",
      },
      viewOnGithub: "GitHub에서 보기",
      setupWithAgent: "에이전트로 설정하기",
      copiedForAgent: "에이전트용으로 복사됨",
      copyFailed: "복사 실패. 다시 시도하세요.",
    },
    selfHost: {
      heading: "셀프 호스트",
      copy: "컴퓨터도, 모델도, 제어권도 내 손에.",
      worksWith: "지원 모델·서비스",
      mock: { weekdays: "평일 9:00", approval: "승인 필요", approve: "승인", deny: "거부" },
      features: [
        { title: "원하는 모델", body: "봇마다 다른 모델을 선택하세요." },
        { title: "예약한 시간에 실행", body: "컴퓨터가 꺼져 있어도 계속 일합니다." },
        { title: "내가 정하는 권한", body: "승인이 필요한 작업을 정하세요." },
      ],
    },
    platforms: {
      heading: "어디서든",
      web: "웹",
      desktop: "데스크톱",
      mobile: "모바일",
    },
    channels: {
      heading: "어디서든 메시지하세요",
      copy: "Slack에서 봇을 멘션하거나 휴대폰으로 문자를 보내세요.",
      mock: {
        ask: "오늘 팔로업할 사람이 누구야?",
        reply: "이번 주에 연락이 끊긴 리드가 세 명 있어요. 초안은 스레드에 있어요.",
      },
    },
    features: {
      heading: "채팅 그 이상",
      items: {
        call: {
          title: "통화와 회의",
          body: "봇이 앱에서 전화하거나 Zoom 또는 Google Meet에 참여해 회의록을 작성해요.",
        },
        apps: {
          title: "쓰던 앱에서 일해요",
          body: "Gmail, GitHub, Notion, 그리고 모든 MCP 서버를 연결하세요.",
        },
        memory: { title: "기억해요", body: "봇은 배운 것을 기억하고 팀과 공유해요." },
        triggers: {
          title: "스스로 깨어나요",
          body: "일정, 웹훅, GitHub 이벤트, 또는 지켜보던 변화에 맞춰 움직여요.",
        },
        team: { title: "일을 넘겨요", body: "봇끼리 일을 맡기고 그룹으로 함께 일해요." },
        teach: {
          title: "보고 배워요",
          body: "봇의 컴퓨터에서 한 번 보여 주세요. 그 과정을 스킬로 저장해요.",
        },
      },
      mock: {
        calling: "전화 거는 중…",
        memory: "메모리",
        memoryNotes: ["짧은 답장을 선호함", "Acme 3월 갱신"],
        triggers: ["평일 9:00", "새 GitHub 이슈", "웹훅"],
        recording: "녹화 중",
        skillSaved: "스킬로 저장됨",
      },
    },
    faq: {
      heading: "질문",
      items: [
        {
          question: "Claude Pro/Max 또는 ChatGPT Plus/Pro 구독을 쓸 수 있나요?",
          answer:
            "네. 해당 요금제로 ChatGPT에 로그인하세요. Claude Pro나 Max를 쓰려면 소스 코드에서 Superbot를 본인 전용으로 직접 호스팅하고, 본인 계정으로 로그인한 공식 Claude Code CLI를 통해 실행하세요. API 키를 연결해도 됩니다. 자세한 내용은 문서의 Model subscriptions를 확인하세요.",
        },
        {
          question: "로컬 모델을 쓸 수 있나요?",
          answer:
            "네. Ollama나 LM Studio 같은 로컬 OpenAI 호환 서버에 봇을 연결하세요. 봇마다 다른 모델을 쓸 수 있습니다.",
        },
      ],
    },
    openSource: {
      heading: "오픈소스",
      copy: "Apache-2.0. 직접 실행하고 원하는 대로 수정하세요.",
      starOnGithub: "GitHub에서 Star",
      readTheDocs: "문서 읽기",
      cloudTitle: "Cloud",
      cloudBadge: "베타",
    },
    cta: {
      heading: "첫 봇을 만나보세요",
      copy: "다음 할 일을 맡겨 보세요.",
      openSourceValue: "오픈소스",
      selfHostValue: "셀프 호스트",
      stats: [
        { value: "stars", label: "GitHub 스타" },
        { value: "license", label: "라이선스" },
        { value: "openSource", label: "모든 기능 무료" },
        { value: "selfHost", label: "당신 머신" },
      ],
    },
    footer: {
      navLabel: "푸터",
      languagesLabel: "언어",
      links: {
        docs: "문서",
        product: "제품",
        changelog: "변경 내역",
        download: "다운로드",
      },
    },
  },
  zh: {
    title: "Superbot | 开源 Grok Bot 替代品",
    description:
      "Superbot 是一个开源 Grok Bot 替代品，用于运行真正干活的持久化 AI 队友。密钥、模型、机器，都归你所有。",
    ogImageAlt: "Superbot：真正属于你的 AI 队友。密钥、模型、机器，都归你所有。",
    availableLanguage: "Chinese",
    skipToContent: "跳到主要内容",
    nav: {
      home: "Superbot 首页",
      primary: "主导航",
      menu: "菜单",
      docs: "文档",
      github: "GitHub",
      getStarted: "开始使用",
    },
    hero: {
      eyebrow: "开源",
      heading: "真正属于你的开源 Grok Bot 替代品",
      lead: "把工作交给 Bot，随时用任意设备查看。",
      getStarted: "开始使用",
      download: {
        mac: "下载 macOS 版",
        windows: "下载 Windows 版",
        linux: "下载 Linux 版",
        ios: "下载 iOS 版",
        android: "下载 Android 版",
      },
      viewOnGithub: "在 GitHub 上查看",
      setupWithAgent: "用你的智能体安装",
      copiedForAgent: "已为你的智能体复制",
      copyFailed: "复制失败。请重试。",
    },
    selfHost: {
      heading: "自托管",
      copy: "电脑、模型、控制权，都归你。",
      worksWith: "支持",
      mock: { weekdays: "工作日 9:00", approval: "需要审批", approve: "批准", deny: "拒绝" },
      features: [
        { title: "自选模型", body: "为每个 Bot 选择不同的模型。" },
        { title: "按时自动执行", body: "电脑关机时也照常工作。" },
        { title: "由你设定权限", body: "决定哪些操作需要你批准。" },
      ],
    },
    platforms: {
      heading: "随时随地",
      web: "网页版",
      desktop: "桌面端",
      mobile: "移动端",
    },
    channels: {
      heading: "随时随地发消息",
      copy: "在 Slack 里 @ 一个机器人，或用手机给它发短信。",
      mock: { ask: "今天该跟进谁？", reply: "本周有三个潜在客户没回音了。草稿已放在线程里。" },
    },
    features: {
      heading: "不止聊天",
      items: {
        call: {
          title: "通话和会议",
          body: "机器人可以在应用里给你打电话，也能加入 Zoom 或 Google Meet 并生成文字记录。",
        },
        apps: {
          title: "在你的应用里工作",
          body: "连接 Gmail、GitHub、Notion 以及任何 MCP 服务器。",
        },
        memory: { title: "记得住", body: "机器人会记住学到的东西，并与团队共享。" },
        triggers: { title: "自己醒来", body: "按计划、Webhook、GitHub 事件，或它关注的变化触发。" },
        team: { title: "把工作交出去", body: "机器人之间互相委派，也能在群组里协作。" },
        teach: { title: "看一遍就会", body: "在它的电脑上演示一次任务，它会把步骤存成技能。" },
      },
      mock: {
        calling: "呼叫中…",
        memory: "记忆",
        memoryNotes: ["喜欢简短回复", "Acme 三月续约"],
        triggers: ["工作日 9:00", "新的 GitHub issue", "Webhook"],
        recording: "录制中",
        skillSaved: "已存为技能",
      },
    },
    faq: {
      heading: "常见问题",
      items: [
        {
          question: "可以用我的 Claude Pro/Max 或 ChatGPT Plus/Pro 订阅吗？",
          answer:
            "可以。使用符合条件的套餐登录 ChatGPT。若要使用 Claude Pro 或 Max，请从源码自行托管仅供你本人使用的 Superbot，并通过用你的账号登录的官方 Claude Code CLI 运行。你也可以连接 API 密钥。详情见文档中的 Model subscriptions。",
        },
        {
          question: "可以用本地模型吗？",
          answer:
            "可以。把 Bot 指向 Ollama 或 LM Studio 这类本地 OpenAI 兼容服务。每个 Bot 可以使用不同的模型。",
        },
      ],
    },
    openSource: {
      heading: "开源",
      copy: "Apache-2.0。自由运行、修改，按需定制。",
      starOnGithub: "在 GitHub 上点星",
      readTheDocs: "阅读文档",
      cloudTitle: "云端",
      cloudBadge: "测试版",
    },
    cta: {
      heading: "认识你的第一个 Bot",
      copy: "把下一项任务交给 Bot。",
      openSourceValue: "开源",
      selfHostValue: "自托管",
      stats: [
        { value: "stars", label: "GitHub 星标" },
        { value: "license", label: "许可证" },
        { value: "openSource", label: "全部功能，免费使用" },
        { value: "selfHost", label: "你的机器" },
      ],
    },
    footer: {
      navLabel: "页脚",
      languagesLabel: "语言",
      links: {
        docs: "文档",
        product: "产品",
        changelog: "更新日志",
        download: "下载",
      },
    },
  },
  ja: {
    title: "Superbot | オープンソースの Grok Bot 代替ツール",
    description:
      "Superbot は、実際の仕事をこなす常駐型 AI チームメイトのための、オープンソースの Grok Bot 代替ツールです。キーもモデルもマシンも、すべてあなたのものです。",
    ogImageAlt:
      "Superbot。本当に自分のものにできる AI チームメイト。キーもモデルもマシンも、すべてあなたのもの。",
    availableLanguage: "Japanese",
    skipToContent: "本文へスキップ",
    nav: {
      home: "Superbot ホーム",
      primary: "メインナビゲーション",
      menu: "メニュー",
      docs: "ドキュメント",
      github: "GitHub",
      getStarted: "はじめる",
    },
    hero: {
      eyebrow: "オープンソース",
      heading: "本当に自分のものにできる、オープンソースの Grok Bot 代替ツール",
      lead: "ボットに仕事を任せて、どのデバイスからでも確認できます。",
      getStarted: "はじめる",
      download: {
        mac: "macOS 版をダウンロード",
        windows: "Windows 版をダウンロード",
        linux: "Linux 版をダウンロード",
        ios: "iOS 版をダウンロード",
        android: "Android 版をダウンロード",
      },
      viewOnGithub: "GitHub で見る",
      setupWithAgent: "エージェントでセットアップ",
      copiedForAgent: "エージェント用にコピーしました",
      copyFailed: "コピーできませんでした。もう一度お試しください。",
    },
    selfHost: {
      heading: "セルフホスト",
      copy: "マシンもモデルも、コントロールもあなたの手に。",
      worksWith: "対応サービス",
      mock: { weekdays: "平日 9:00", approval: "承認が必要", approve: "承認", deny: "拒否" },
      features: [
        { title: "好きなモデルで", body: "ボットごとに別のモデルを選べます。" },
        {
          title: "スケジュールどおりに実行",
          body: "コンピューターの電源が切れていても動き続けます。",
        },
        { title: "制限はあなたが決める", body: "どの操作に承認が必要かを決められます。" },
      ],
    },
    platforms: {
      heading: "どこにいても",
      web: "Web",
      desktop: "デスクトップ",
      mobile: "モバイル",
    },
    channels: {
      heading: "どこからでもメッセージ",
      copy: "Slack でボットをメンション。スマホからテキストも送れます。",
      mock: {
        ask: "今日フォローすべき相手は？",
        reply: "今週返信が止まったリードが3件あります。下書きはスレッドにあります。",
      },
    },
    features: {
      heading: "チャットだけじゃない",
      items: {
        call: {
          title: "通話と会議",
          body: "ボットはアプリから電話をかけ、Zoom や Google Meet に参加して文字起こしもできます。",
        },
        apps: {
          title: "いつものアプリで",
          body: "Gmail、GitHub、Notion、あらゆる MCP サーバーとつなげます。",
        },
        memory: { title: "覚えている", body: "ボットは学んだことを覚え、チームと共有します。" },
        triggers: {
          title: "自分で動き出す",
          body: "スケジュール、Webhook、GitHub のイベント、見張っている変化をきっかけに動きます。",
        },
        team: { title: "仕事を任せ合う", body: "ボット同士で仕事を任せ、グループで協力します。" },
        teach: {
          title: "見て覚える",
          body: "ボットのコンピューターで一度やって見せれば、手順をスキルとして保存します。",
        },
      },
      mock: {
        calling: "発信中…",
        memory: "メモリー",
        memoryNotes: ["短い返信が好み", "Acme は3月に更新"],
        triggers: ["平日 9:00", "新しい GitHub issue", "Webhook"],
        recording: "録画中",
        skillSaved: "スキルとして保存",
      },
    },
    faq: {
      heading: "よくある質問",
      items: [
        {
          question: "Claude Pro/Max や ChatGPT Plus/Pro のサブスクリプションを使えますか？",
          answer:
            "はい。対象プランで ChatGPT にサインインしてください。Claude Pro または Max を使う場合は、Superbot をソースコードから自分専用にセルフホストし、自分のアカウントでサインインした公式の Claude Code CLI 経由で動かします。API キーを接続することもできます。詳しくはドキュメントの Model subscriptions をご覧ください。",
        },
        {
          question: "ローカルモデルを使えますか？",
          answer:
            "はい。Ollama や LM Studio などのローカルの OpenAI 互換サーバーにボットを接続できます。ボットごとに別のモデルを使えます。",
        },
      ],
    },
    openSource: {
      heading: "オープンソース",
      copy: "Apache-2.0。自由に実行し、変更して、自分のものに。",
      starOnGithub: "GitHub で Star する",
      readTheDocs: "ドキュメントを読む",
      cloudTitle: "クラウド",
      cloudBadge: "ベータ",
    },
    cta: {
      heading: "最初のボットを迎えましょう",
      copy: "次のタスクを任せてみましょう。",
      openSourceValue: "オープンソース",
      selfHostValue: "セルフホスト",
      stats: [
        { value: "stars", label: "GitHub スター" },
        { value: "license", label: "ライセンス" },
        { value: "openSource", label: "全機能を無料で" },
        { value: "selfHost", label: "あなたのマシン" },
      ],
    },
    footer: {
      navLabel: "フッター",
      languagesLabel: "言語",
      links: {
        docs: "ドキュメント",
        product: "製品",
        changelog: "変更履歴",
        download: "ダウンロード",
      },
    },
  },
  es: {
    title: "Superbot | Alternativa de código abierto a Grok Bot",
    description:
      "Superbot es una alternativa de código abierto a Grok Bot para compañeros de IA persistentes que hacen trabajo real. Tus claves, tu modelo, tu máquina.",
    ogImageAlt:
      "Superbot. Compañeros de IA que de verdad son tuyos. Tus claves, tu modelo, tu máquina.",
    availableLanguage: "Spanish",
    skipToContent: "Saltar al contenido",
    nav: {
      home: "Inicio de Superbot",
      primary: "Navegación principal",
      menu: "Menú",
      docs: "Documentación",
      github: "GitHub",
      getStarted: "Empezar",
    },
    hero: {
      eyebrow: "Código abierto",
      heading: "La alternativa de código abierto a Grok Bot que de verdad es tuya",
      lead: "Dale un trabajo a tus bots. Síguelos desde cualquier dispositivo.",
      getStarted: "Empezar",
      download: {
        mac: "Descargar para macOS",
        windows: "Descargar para Windows",
        linux: "Descargar para Linux",
        ios: "Descargar para iOS",
        android: "Descargar para Android",
      },
      viewOnGithub: "Ver en GitHub",
      setupWithAgent: "Configurar con tu agente",
      copiedForAgent: "Copiado para tu agente",
      copyFailed: "No se pudo copiar. Inténtalo de nuevo.",
    },
    selfHost: {
      heading: "Autoalojado",
      copy: "Tu máquina, tus modelos, tu control.",
      worksWith: "Funciona con",
      mock: {
        weekdays: "Días laborables a las 9:00",
        approval: "Requiere aprobación",
        approve: "Aprobar",
        deny: "Denegar",
      },
      features: [
        { title: "Tu modelo", body: "Elige un modelo distinto para cada bot." },
        { title: "Trabaja según un horario", body: "Sigue trabajando con tu computadora apagada." },
        { title: "Tú pones los límites", body: "Decide qué acciones necesitan tu aprobación." },
      ],
    },
    platforms: {
      heading: "Dondequiera que estés",
      web: "Web",
      desktop: "Escritorio",
      mobile: "Móvil",
    },
    channels: {
      heading: "Escríbeles desde cualquier lugar",
      copy: "Menciona a un bot en Slack o escríbele desde tu teléfono.",
      mock: {
        ask: "¿quién necesita un seguimiento hoy?",
        reply: "Tres leads dejaron de responder esta semana. Los borradores están en el hilo.",
      },
    },
    features: {
      heading: "Más que un chat",
      items: {
        call: {
          title: "Llamadas y reuniones",
          body: "Tu bot puede llamarte en la app y unirse a Zoom o Google Meet para transcribir la reunión.",
        },
        apps: {
          title: "Trabaja en tus apps",
          body: "Conecta Gmail, GitHub, Notion y cualquier servidor MCP.",
        },
        memory: {
          title: "Recuerda",
          body: "Los bots guardan lo que aprenden y lo comparten con el equipo.",
        },
        triggers: {
          title: "Se activa solo",
          body: "Según un horario, un webhook, un evento de GitHub o un cambio que vigila.",
        },
        team: {
          title: "Reparte el trabajo",
          body: "Los bots se delegan tareas entre sí y trabajan juntos en grupos.",
        },
        teach: {
          title: "Aprende observando",
          body: "Muéstrale una tarea una vez en su computadora. Guarda los pasos como una habilidad.",
        },
      },
      mock: {
        calling: "Llamando…",
        memory: "Memoria",
        memoryNotes: ["Prefiere respuestas cortas", "Acme renueva en marzo"],
        triggers: ["Días laborables a las 9:00", "Nuevo issue de GitHub", "Webhook"],
        recording: "Grabando",
        skillSaved: "Guardado como habilidad",
      },
    },
    faq: {
      heading: "Preguntas frecuentes",
      items: [
        {
          question: "¿Puedo usar mi suscripción a Claude Pro/Max o ChatGPT Plus/Pro?",
          answer:
            "Sí. Inicia sesión con ChatGPT con un plan compatible. Para usar Claude Pro o Max, aloja Superbot desde el código fuente solo para ti y ejecútalo con la CLI oficial de Claude Code, con tu propia cuenta. También puedes conectar una clave de API. Consulta Model subscriptions en la documentación para más detalles.",
        },
        {
          question: "¿Puedo usar un modelo local?",
          answer:
            "Sí. Conecta un bot a un servidor local compatible con OpenAI, como Ollama o LM Studio. Cada bot puede usar un modelo distinto.",
        },
      ],
    },
    openSource: {
      heading: "Código abierto",
      copy: "Apache-2.0. Ejecútalo, modifícalo, hazlo tuyo.",
      starOnGithub: "Dar una estrella en GitHub",
      readTheDocs: "Leer la documentación",
      cloudTitle: "Cloud",
      cloudBadge: "Beta",
    },
    cta: {
      heading: "Conoce a tu primer bot",
      copy: "Delégale tu próxima tarea.",
      openSourceValue: "Código abierto",
      selfHostValue: "Autoalojado",
      stats: [
        { value: "stars", label: "Estrellas en GitHub" },
        { value: "license", label: "Licencia" },
        { value: "openSource", label: "Todas las funciones, gratis" },
        { value: "selfHost", label: "Tu máquina" },
      ],
    },
    footer: {
      navLabel: "Pie de página",
      languagesLabel: "Idioma",
      links: {
        docs: "Documentación",
        product: "Producto",
        changelog: "Novedades",
        download: "Descargar",
      },
    },
  },
  fr: {
    title: "Superbot | Alternative open source à Grok Bot",
    description:
      "Superbot est une alternative open source à Grok Bot pour des coéquipiers IA persistants qui font un vrai travail. Vos clés, votre modèle, votre machine.",
    ogImageAlt:
      "Superbot. Des coéquipiers IA qui vous appartiennent vraiment. Vos clés, votre modèle, votre machine.",
    availableLanguage: "French",
    skipToContent: "Aller au contenu",
    nav: {
      home: "Accueil Superbot",
      primary: "Navigation principale",
      menu: "Menu",
      docs: "Documentation",
      github: "GitHub",
      getStarted: "Commencer",
    },
    hero: {
      eyebrow: "Open source",
      heading: "L’alternative open source à Grok Bot qui vous appartient vraiment",
      lead: "Confiez une mission à vos bots. Suivez-les depuis n’importe quel appareil.",
      getStarted: "Commencer",
      download: {
        mac: "Télécharger pour macOS",
        windows: "Télécharger pour Windows",
        linux: "Télécharger pour Linux",
        ios: "Télécharger pour iOS",
        android: "Télécharger pour Android",
      },
      viewOnGithub: "Voir sur GitHub",
      setupWithAgent: "Configurer avec votre agent",
      copiedForAgent: "Copié pour votre agent",
      copyFailed: "Échec de la copie. Réessayez.",
    },
    selfHost: {
      heading: "Auto-hébergé",
      copy: "Votre machine, vos modèles, votre contrôle.",
      worksWith: "Fonctionne avec",
      mock: {
        weekdays: "Jours ouvrés à 9:00",
        approval: "Approbation requise",
        approve: "Approuver",
        deny: "Refuser",
      },
      features: [
        { title: "Votre modèle", body: "Choisissez un modèle différent pour chaque bot." },
        {
          title: "Travaille selon un planning",
          body: "Continue de travailler, même ordinateur éteint.",
        },
        {
          title: "Vous fixez les limites",
          body: "Décidez quelles actions nécessitent votre approbation.",
        },
      ],
    },
    platforms: {
      heading: "Où que vous soyez",
      web: "Web",
      desktop: "Ordinateur",
      mobile: "Mobile",
    },
    channels: {
      heading: "Écrivez-leur partout",
      copy: "Mentionnez un bot dans Slack ou envoyez-lui un SMS depuis votre téléphone.",
      mock: {
        ask: "qui a besoin d’une relance aujourd’hui ?",
        reply: "Trois prospects ne répondent plus cette semaine. Les brouillons sont dans le fil.",
      },
    },
    features: {
      heading: "Plus qu’un chat",
      items: {
        call: {
          title: "Appels et réunions",
          body: "Votre bot peut vous appeler dans l’app et rejoindre Zoom ou Google Meet pour transcrire la réunion.",
        },
        apps: {
          title: "Travaille dans vos apps",
          body: "Connectez Gmail, GitHub, Notion et n’importe quel serveur MCP.",
        },
        memory: {
          title: "Se souvient",
          body: "Les bots retiennent ce qu’ils apprennent et le partagent avec l’équipe.",
        },
        triggers: {
          title: "Se lance tout seul",
          body: "Selon un planning, un webhook, un événement GitHub ou un changement qu’il surveille.",
        },
        team: {
          title: "Passe le relais",
          body: "Les bots se délèguent des tâches et travaillent ensemble en groupes.",
        },
        teach: {
          title: "Apprend en observant",
          body: "Montrez-lui une tâche une fois sur son ordinateur. Il enregistre les étapes comme compétence.",
        },
      },
      mock: {
        calling: "Appel en cours…",
        memory: "Mémoire",
        memoryNotes: ["Préfère les réponses courtes", "Acme renouvelle en mars"],
        triggers: ["Jours ouvrés à 9:00", "Nouvelle issue GitHub", "Webhook"],
        recording: "Enregistrement",
        skillSaved: "Enregistré comme compétence",
      },
    },
    faq: {
      heading: "FAQ",
      items: [
        {
          question: "Puis-je utiliser mon abonnement Claude Pro/Max ou ChatGPT Plus/Pro ?",
          answer:
            "Oui. Connectez-vous avec ChatGPT si votre offre est éligible. Pour Claude Pro ou Max, auto-hébergez Superbot à partir du code source pour vous seul et faites-le tourner via la CLI officielle Claude Code, connectée à votre compte. Vous pouvez aussi connecter une clé API. Voir Model subscriptions dans la documentation pour les détails.",
        },
        {
          question: "Puis-je utiliser un modèle local ?",
          answer:
            "Oui. Reliez un bot à un serveur local compatible OpenAI comme Ollama ou LM Studio. Chaque bot peut utiliser un modèle différent.",
        },
      ],
    },
    openSource: {
      heading: "Open source",
      copy: "Apache-2.0. Exécutez-le, modifiez-le, appropriez-le-vous.",
      starOnGithub: "Ajouter une étoile sur GitHub",
      readTheDocs: "Lire la documentation",
      cloudTitle: "Cloud",
      cloudBadge: "Bêta",
    },
    cta: {
      heading: "Rencontrez votre premier bot",
      copy: "Confiez-lui votre prochaine tâche.",
      openSourceValue: "Open source",
      selfHostValue: "Auto-hébergé",
      stats: [
        { value: "stars", label: "Étoiles GitHub" },
        { value: "license", label: "Licence" },
        { value: "openSource", label: "Toutes les fonctionnalités, gratuites" },
        { value: "selfHost", label: "Votre machine" },
      ],
    },
    footer: {
      navLabel: "Pied de page",
      languagesLabel: "Langue",
      links: {
        docs: "Documentation",
        product: "Produit",
        changelog: "Nouveautés",
        download: "Télécharger",
      },
    },
  },
  "pt-br": {
    title: "Superbot | Alternativa de código aberto ao Grok Bot",
    description:
      "Superbot é uma alternativa de código aberto ao Grok Bot para colegas de IA persistentes que fazem trabalho de verdade. Suas chaves, seu modelo, sua máquina.",
    ogImageAlt:
      "Superbot. Colegas de IA que são realmente seus. Suas chaves, seu modelo, sua máquina.",
    availableLanguage: "Portuguese",
    skipToContent: "Pular para o conteúdo",
    nav: {
      home: "Página inicial do Superbot",
      primary: "Navegação principal",
      menu: "Menu",
      docs: "Documentação",
      github: "GitHub",
      getStarted: "Começar",
    },
    hero: {
      eyebrow: "Código aberto",
      heading: "A alternativa de código aberto ao Grok Bot que é realmente sua",
      lead: "Dê um trabalho aos seus bots. Acompanhe de qualquer dispositivo.",
      getStarted: "Começar",
      download: {
        mac: "Baixar para macOS",
        windows: "Baixar para Windows",
        linux: "Baixar para Linux",
        ios: "Baixar para iOS",
        android: "Baixar para Android",
      },
      viewOnGithub: "Ver no GitHub",
      setupWithAgent: "Configurar com seu agente",
      copiedForAgent: "Copiado para seu agente",
      copyFailed: "Falha ao copiar. Tente novamente.",
    },
    selfHost: {
      heading: "Auto-hospedado",
      copy: "Sua máquina, seus modelos, seu controle.",
      worksWith: "Funciona com",
      mock: {
        weekdays: "Dias úteis às 9:00",
        approval: "Aprovação necessária",
        approve: "Aprovar",
        deny: "Negar",
      },
      features: [
        { title: "Seu modelo", body: "Escolha um modelo diferente para cada bot." },
        {
          title: "Trabalha com agendamento",
          body: "Continua trabalhando com seu computador desligado.",
        },
        { title: "Você define os limites", body: "Decida quais ações precisam da sua aprovação." },
      ],
    },
    platforms: {
      heading: "Onde você estiver",
      web: "Web",
      desktop: "Desktop",
      mobile: "Celular",
    },
    channels: {
      heading: "Fale com eles em qualquer lugar",
      copy: "Mencione um bot no Slack ou mande uma mensagem pelo celular.",
      mock: {
        ask: "quem precisa de um follow-up hoje?",
        reply: "Três leads sumiram esta semana. Os rascunhos estão na conversa.",
      },
    },
    features: {
      heading: "Mais que um chat",
      items: {
        call: {
          title: "Chamadas e reuniões",
          body: "Seu bot pode ligar pelo app e entrar no Zoom ou no Google Meet para transcrever a reunião.",
        },
        apps: {
          title: "Funciona nos seus apps",
          body: "Conecte Gmail, GitHub, Notion e qualquer servidor MCP.",
        },
        memory: {
          title: "Lembra",
          body: "Os bots guardam o que aprendem e compartilham com a equipe.",
        },
        triggers: {
          title: "Entra em ação sozinho",
          body: "Por agendamento, webhook, evento do GitHub ou uma mudança que ele monitora.",
        },
        team: {
          title: "Divide o trabalho",
          body: "Os bots delegam tarefas entre si e trabalham juntos em grupos.",
        },
        teach: {
          title: "Aprende observando",
          body: "Mostre uma tarefa uma vez no computador dele. Ele salva os passos como uma habilidade.",
        },
      },
      mock: {
        calling: "Ligando…",
        memory: "Memória",
        memoryNotes: ["Prefere respostas curtas", "Acme renova em março"],
        triggers: ["Dias úteis às 9:00", "Nova issue no GitHub", "Webhook"],
        recording: "Gravando",
        skillSaved: "Salvo como habilidade",
      },
    },
    faq: {
      heading: "Perguntas frequentes",
      items: [
        {
          question: "Posso usar minha assinatura do Claude Pro/Max ou ChatGPT Plus/Pro?",
          answer:
            "Sim. Entre com o ChatGPT em um plano elegível. Para usar Claude Pro ou Max, hospede o Superbot a partir do código-fonte só para você e execute-o pela CLI oficial do Claude Code, conectada à sua conta. Você também pode conectar uma chave de API. Veja Model subscriptions na documentação para mais detalhes.",
        },
        {
          question: "Posso usar um modelo local?",
          answer:
            "Sim. Aponte um bot para um servidor local compatível com OpenAI, como Ollama ou LM Studio. Cada bot pode usar um modelo diferente.",
        },
      ],
    },
    openSource: {
      heading: "Código aberto",
      copy: "Apache-2.0. Rode, modifique, deixe do seu jeito.",
      starOnGithub: "Dar estrela no GitHub",
      readTheDocs: "Ler a documentação",
      cloudTitle: "Cloud",
      cloudBadge: "Beta",
    },
    cta: {
      heading: "Conheça seu primeiro bot",
      copy: "Entregue sua próxima tarefa.",
      openSourceValue: "Código aberto",
      selfHostValue: "Auto-hospedado",
      stats: [
        { value: "stars", label: "Estrelas no GitHub" },
        { value: "license", label: "Licença" },
        { value: "openSource", label: "Todos os recursos, grátis" },
        { value: "selfHost", label: "Sua máquina" },
      ],
    },
    footer: {
      navLabel: "Rodapé",
      languagesLabel: "Idioma",
      links: {
        docs: "Documentação",
        product: "Produto",
        changelog: "Novidades",
        download: "Baixar",
      },
    },
  },
  nl: {
    title: "Superbot | Open source alternatief voor Grok Bot",
    description:
      "Superbot is een open source alternatief voor Grok Bot voor blijvende AI-teamgenoten die echt werk doen. Jouw keys, jouw model, jouw machine.",
    ogImageAlt:
      "Superbot. AI-teamgenoten die echt van jou zijn. Jouw keys, jouw model, jouw machine.",
    availableLanguage: "Dutch",
    skipToContent: "Naar inhoud springen",
    nav: {
      home: "Superbot-startpagina",
      primary: "Hoofdnavigatie",
      menu: "Menu",
      docs: "Docs",
      github: "GitHub",
      getStarted: "Aan de slag",
    },
    hero: {
      eyebrow: "Open source",
      heading: "Het open source alternatief voor Grok Bot dat echt van jou is",
      lead: "Geef je bots een taak. Kijk mee vanaf elk apparaat.",
      getStarted: "Aan de slag",
      download: {
        mac: "Downloaden voor macOS",
        windows: "Downloaden voor Windows",
        linux: "Downloaden voor Linux",
        ios: "Downloaden voor iOS",
        android: "Downloaden voor Android",
      },
      viewOnGithub: "Bekijken op GitHub",
      setupWithAgent: "Instellen met je agent",
      copiedForAgent: "Gekopieerd voor je agent",
      copyFailed: "Kopiëren mislukt. Probeer het opnieuw.",
    },
    selfHost: {
      heading: "Zelf gehost",
      copy: "Jouw machine, jouw modellen, jouw controle.",
      worksWith: "Werkt met",
      mock: {
        weekdays: "Werkdagen om 9:00",
        approval: "Goedkeuring vereist",
        approve: "Goedkeuren",
        deny: "Weigeren",
      },
      features: [
        { title: "Jouw model", body: "Kies voor elke bot een ander model." },
        { title: "Werkt volgens schema", body: "Blijft werken, ook als je computer uit staat." },
        {
          title: "Jij bepaalt de grenzen",
          body: "Bepaal welke acties jouw goedkeuring nodig hebben.",
        },
      ],
    },
    platforms: {
      heading: "Waar je ook bent",
      web: "Web",
      desktop: "Desktop",
      mobile: "Mobiel",
    },
    channels: {
      heading: "Stuur ze overal een bericht",
      copy: "Noem een bot in Slack of stuur hem een bericht vanaf je telefoon.",
      mock: {
        ask: "wie heeft vandaag een follow-up nodig?",
        reply: "Drie leads zijn deze week stil geworden. De concepten staan in de thread.",
      },
    },
    features: {
      heading: "Meer dan chat",
      items: {
        call: {
          title: "Gesprekken en vergaderingen",
          body: "Je bot kan je in de app bellen en deelnemen aan Zoom of Google Meet voor een transcript.",
        },
        apps: {
          title: "Werkt in je apps",
          body: "Koppel Gmail, GitHub, Notion en elke MCP-server.",
        },
        memory: { title: "Onthoudt", body: "Bots bewaren wat ze leren en delen het met het team." },
        triggers: {
          title: "Komt zelf in actie",
          body: "Volgens schema, via een webhook, bij een GitHub-event of bij een wijziging die hij in de gaten houdt.",
        },
        team: {
          title: "Draagt werk over",
          body: "Bots delegeren aan elkaar en werken samen in groepen.",
        },
        teach: {
          title: "Leert door te kijken",
          body: "Doe een taak één keer voor op zijn computer. Hij slaat de stappen op als skill.",
        },
      },
      mock: {
        calling: "Belt…",
        memory: "Geheugen",
        memoryNotes: ["Houdt van korte antwoorden", "Acme verlengt in maart"],
        triggers: ["Werkdagen om 9:00", "Nieuw GitHub-issue", "Webhook"],
        recording: "Opname",
        skillSaved: "Opgeslagen als skill",
      },
    },
    faq: {
      heading: "FAQ",
      items: [
        {
          question: "Kan ik mijn Claude Pro/Max- of ChatGPT Plus/Pro-abonnement gebruiken?",
          answer:
            "Ja. Log in met ChatGPT met een geschikt abonnement. Voor Claude Pro of Max host je Superbot vanuit de broncode alleen voor jezelf en draai je het via de officiële Claude Code CLI, ingelogd met je eigen account. Je kunt ook een API-sleutel koppelen. Zie Model subscriptions in de documentatie voor details.",
        },
        {
          question: "Kan ik een lokaal model draaien?",
          answer:
            "Ja. Laat een bot naar een lokale OpenAI-compatibele server wijzen, zoals Ollama of LM Studio. Elke bot kan een ander model gebruiken.",
        },
      ],
    },
    openSource: {
      heading: "Open source",
      copy: "Apache-2.0. Draai het, pas het aan, maak het je eigen.",
      starOnGithub: "Ster geven op GitHub",
      readTheDocs: "Lees de docs",
      cloudTitle: "Cloud",
      cloudBadge: "Bèta",
    },
    cta: {
      heading: "Maak kennis met je eerste bot",
      copy: "Draag je volgende taak over.",
      openSourceValue: "Open source",
      selfHostValue: "Zelf hosten",
      stats: [
        { value: "stars", label: "GitHub-sterren" },
        { value: "license", label: "Licentie" },
        { value: "openSource", label: "Alle functies, gratis" },
        { value: "selfHost", label: "Jouw machine" },
      ],
    },
    footer: {
      navLabel: "Voettekst",
      languagesLabel: "Taal",
      links: {
        docs: "Documentatie",
        product: "Product",
        changelog: "Wijzigingslog",
        download: "Downloaden",
      },
    },
  },
  ru: {
    title: "Superbot | Альтернатива Grok Bot с открытым исходным кодом",
    description:
      "Superbot — альтернатива Grok Bot с открытым исходным кодом: постоянные ИИ-коллеги, которые выполняют реальную работу. Ваши ключи, ваша модель, ваш компьютер.",
    ogImageAlt:
      "Superbot. ИИ-коллеги, которые действительно принадлежат вам. Ваши ключи, ваша модель, ваш компьютер.",
    availableLanguage: "Russian",
    skipToContent: "Перейти к содержимому",
    nav: {
      home: "Главная Superbot",
      primary: "Основная навигация",
      menu: "Меню",
      docs: "Документация",
      github: "GitHub",
      getStarted: "Начать",
    },
    hero: {
      eyebrow: "Открытый исходный код",
      heading: "Альтернатива Grok Bot с открытым исходным кодом, которая действительно ваша",
      lead: "Дайте ботам работу. Следите за ней с любого устройства.",
      getStarted: "Начать",
      download: {
        mac: "Скачать для macOS",
        windows: "Скачать для Windows",
        linux: "Скачать для Linux",
        ios: "Скачать для iOS",
        android: "Скачать для Android",
      },
      viewOnGithub: "Открыть на GitHub",
      setupWithAgent: "Настроить с помощью агента",
      copiedForAgent: "Скопировано для агента",
      copyFailed: "Не удалось скопировать. Попробуйте ещё раз.",
    },
    selfHost: {
      heading: "На своём сервере",
      copy: "Ваш компьютер, ваши модели, ваш контроль.",
      worksWith: "Работает с",
      mock: {
        weekdays: "По будням в 9:00",
        approval: "Требуется одобрение",
        approve: "Утвердить",
        deny: "Запретить",
      },
      features: [
        { title: "Ваша модель", body: "Выберите свою модель для каждого бота." },
        { title: "Работа по расписанию", body: "Работает, даже когда компьютер выключен." },
        { title: "Границы задаёте вы", body: "Решайте, какие действия требуют вашего одобрения." },
      ],
    },
    platforms: {
      heading: "Где бы вы ни были",
      web: "Веб",
      desktop: "Компьютер",
      mobile: "Телефон",
    },
    channels: {
      heading: "Пишите им где угодно",
      copy: "Упомяните бота в Slack или напишите ему с телефона.",
      mock: {
        ask: "кому сегодня нужно напомнить о себе?",
        reply: "Три лида замолчали на этой неделе. Черновики в треде.",
      },
    },
    features: {
      heading: "Больше, чем чат",
      items: {
        call: {
          title: "Звонки и встречи",
          body: "Бот может позвонить вам в приложении и расшифровать встречу в Zoom или Google Meet.",
        },
        apps: {
          title: "Работает в ваших приложениях",
          body: "Подключите Gmail, GitHub, Notion и любой MCP-сервер.",
        },
        memory: {
          title: "Помнит",
          body: "Боты сохраняют то, что узнали, и делятся этим с командой.",
        },
        triggers: {
          title: "Запускается сам",
          body: "По расписанию, по вебхуку, по событию GitHub или при изменении, за которым он следит.",
        },
        team: {
          title: "Передаёт работу",
          body: "Боты поручают задачи друг другу и работают вместе в группах.",
        },
        teach: {
          title: "Учится, наблюдая",
          body: "Покажите задачу один раз на его компьютере. Он сохранит шаги как навык.",
        },
      },
      mock: {
        calling: "Вызов…",
        memory: "Память",
        memoryNotes: ["Предпочитает короткие ответы", "Acme продлевает в марте"],
        triggers: ["По будням в 9:00", "Новый issue в GitHub", "Вебхук"],
        recording: "Запись",
        skillSaved: "Сохранено как навык",
      },
    },
    faq: {
      heading: "Частые вопросы",
      items: [
        {
          question: "Можно ли использовать подписку Claude Pro/Max или ChatGPT Plus/Pro?",
          answer:
            "Да. Войдите через ChatGPT с подходящим тарифом. Чтобы использовать Claude Pro или Max, разверните Superbot из исходного кода только для себя и запускайте его через официальный Claude Code CLI, вошедший в ваш аккаунт. Можно также подключить API-ключ. Подробности — на странице Model subscriptions в документации.",
        },
        {
          question: "Можно ли запустить локальную модель?",
          answer:
            "Да. Направьте бота на локальный OpenAI-совместимый сервер, например Ollama или LM Studio. Каждый бот может использовать свою модель.",
        },
      ],
    },
    openSource: {
      heading: "Открытый исходный код",
      copy: "Apache-2.0. Запускайте, меняйте, настраивайте под себя.",
      starOnGithub: "Поставить звезду на GitHub",
      readTheDocs: "Читать документацию",
      cloudTitle: "Облако",
      cloudBadge: "Бета",
    },
    cta: {
      heading: "Познакомьтесь с первым ботом",
      copy: "Передайте ему следующую задачу.",
      openSourceValue: "Открытый код",
      selfHostValue: "Свой сервер",
      stats: [
        { value: "stars", label: "Звёзды на GitHub" },
        { value: "license", label: "Лицензия" },
        { value: "openSource", label: "Все функции бесплатно" },
        { value: "selfHost", label: "Ваш компьютер" },
      ],
    },
    footer: {
      navLabel: "Нижнее меню",
      languagesLabel: "Язык",
      links: {
        docs: "Документация",
        product: "Продукт",
        changelog: "Журнал изменений",
        download: "Скачать",
      },
    },
  },
  tr: {
    title: "Superbot | Açık kaynaklı Grok Bot alternatifi",
    description:
      "Superbot, gerçek işler yapan kalıcı yapay zekâ ekip arkadaşları için açık kaynaklı bir Grok Bot alternatifidir. Sizin anahtarlarınız, sizin modeliniz, sizin makineniz.",
    ogImageAlt:
      "Superbot. Gerçekten size ait yapay zekâ ekip arkadaşları. Sizin anahtarlarınız, sizin modeliniz, sizin makineniz.",
    availableLanguage: "Turkish",
    skipToContent: "İçeriğe geç",
    nav: {
      home: "Superbot ana sayfa",
      primary: "Ana menü",
      menu: "Menü",
      docs: "Belgeler",
      github: "GitHub",
      getStarted: "Başlayın",
    },
    hero: {
      eyebrow: "Açık kaynak",
      heading: "Gerçekten size ait, açık kaynaklı Grok Bot alternatifi",
      lead: "Botlarınıza bir iş verin. Her cihazdan takip edin.",
      getStarted: "Başlayın",
      download: {
        mac: "macOS için indir",
        windows: "Windows için indir",
        linux: "Linux için indir",
        ios: "iOS için indir",
        android: "Android için indir",
      },
      viewOnGithub: "GitHub'da görüntüle",
      setupWithAgent: "Ajanınızla kurun",
      copiedForAgent: "Ajanınız için kopyalandı",
      copyFailed: "Kopyalanamadı. Tekrar deneyin.",
    },
    selfHost: {
      heading: "Kendi sunucunuzda",
      copy: "Sizin makineniz, sizin modelleriniz, sizin kontrolünüz.",
      worksWith: "Şunlarla çalışır",
      mock: {
        weekdays: "Hafta içi 9:00'da",
        approval: "Onay gerekli",
        approve: "Onayla",
        deny: "Reddet",
      },
      features: [
        { title: "Sizin modeliniz", body: "Her bot için farklı bir model seçin." },
        { title: "Zamanlanmış çalışma", body: "Bilgisayarınız kapalıyken bile çalışır." },
        {
          title: "Sınırları siz belirlersiniz",
          body: "Hangi işlemlerin onayınızı gerektirdiğine karar verin.",
        },
      ],
    },
    platforms: {
      heading: "Nerede olursanız olun",
      web: "Web",
      desktop: "Masaüstü",
      mobile: "Mobil",
    },
    channels: {
      heading: "Onlara her yerden yazın",
      copy: "Slack'te bir botu etiketleyin veya telefonunuzdan mesaj atın.",
      mock: {
        ask: "bugün kimin takibe ihtiyacı var?",
        reply: "Bu hafta üç potansiyel müşteriden ses çıkmadı. Taslaklar başlıkta.",
      },
    },
    features: {
      heading: "Sohbetten fazlası",
      items: {
        call: {
          title: "Aramalar ve toplantılar",
          body: "Botunuz sizi uygulamada arayabilir ve Zoom veya Google Meet toplantılarını yazıya dökebilir.",
        },
        apps: {
          title: "Uygulamalarınızda çalışır",
          body: "Gmail, GitHub, Notion ve herhangi bir MCP sunucusunu bağlayın.",
        },
        memory: { title: "Hatırlar", body: "Botlar öğrendiklerini saklar ve ekiple paylaşır." },
        triggers: {
          title: "Kendiliğinden devreye girer",
          body: "Bir zamanlamayla, bir webhook ile, bir GitHub olayıyla veya izlediği bir değişiklikle.",
        },
        team: {
          title: "İşi devreder",
          body: "Botlar birbirine görev verir ve gruplar halinde birlikte çalışır.",
        },
        teach: {
          title: "İzleyerek öğrenir",
          body: "Bir görevi kendi bilgisayarında bir kez gösterin. Adımları beceri olarak kaydeder.",
        },
      },
      mock: {
        calling: "Aranıyor…",
        memory: "Hafıza",
        memoryNotes: ["Kısa yanıtları tercih eder", "Acme mart ayında yeniliyor"],
        triggers: ["Hafta içi 9:00'da", "Yeni GitHub issue'su", "Webhook"],
        recording: "Kaydediliyor",
        skillSaved: "Beceri olarak kaydedildi",
      },
    },
    faq: {
      heading: "SSS",
      items: [
        {
          question: "Claude Pro/Max veya ChatGPT Plus/Pro aboneliğimi kullanabilir miyim?",
          answer:
            "Evet. Uygun bir planla ChatGPT ile giriş yapın. Claude Pro veya Max kullanmak için Superbot'yu kaynak koddan yalnızca kendiniz için barındırın ve kendi hesabınızla giriş yapılmış resmi Claude Code CLI üzerinden çalıştırın. Bir API anahtarı da bağlayabilirsiniz. Ayrıntılar için belgelerdeki Model subscriptions sayfasına bakın.",
        },
        {
          question: "Yerel bir model çalıştırabilir miyim?",
          answer:
            "Evet. Bir botu Ollama veya LM Studio gibi yerel bir OpenAI uyumlu sunucuya yönlendirin. Her bot farklı bir model kullanabilir.",
        },
      ],
    },
    openSource: {
      heading: "Açık kaynak",
      copy: "Apache-2.0. Çalıştırın, değiştirin, size göre uyarlayın.",
      starOnGithub: "GitHub'da yıldız verin",
      readTheDocs: "Belgeleri okuyun",
      cloudTitle: "Bulut",
      cloudBadge: "Beta",
    },
    cta: {
      heading: "İlk botunuzla tanışın",
      copy: "Sıradaki görevinizi devredin.",
      openSourceValue: "Açık kaynak",
      selfHostValue: "Kendi sunucunuz",
      stats: [
        { value: "stars", label: "GitHub yıldızı" },
        { value: "license", label: "Lisans" },
        { value: "openSource", label: "Tüm özellikler ücretsiz" },
        { value: "selfHost", label: "Sizin makineniz" },
      ],
    },
    footer: {
      navLabel: "Alt bilgi",
      languagesLabel: "Dil",
      links: {
        docs: "Belgeler",
        product: "Ürün",
        changelog: "Değişiklik günlüğü",
        download: "İndir",
      },
    },
  },
  he: {
    title: "Superbot | חלופת קוד פתוח ל-Grok Bot",
    description:
      "Superbot היא חלופת קוד פתוח ל-Grok Bot לעמיתי AI קבועים שעושים עבודה אמיתית. המפתחות שלך, המודל שלך, המכונה שלך.",
    ogImageAlt: "Superbot. עמיתי AI ששייכים לך באמת. המפתחות שלך, המודל שלך, המכונה שלך.",
    availableLanguage: "Hebrew",
    skipToContent: "דילוג לתוכן",
    nav: {
      home: "דף הבית של Superbot",
      primary: "ניווט ראשי",
      menu: "תפריט",
      docs: "תיעוד",
      github: "GitHub",
      getStarted: "להתחיל",
    },
    hero: {
      eyebrow: "קוד פתוח",
      heading: "חלופת הקוד הפתוח ל-Grok Bot ששייכת לך באמת",
      lead: "נותנים לבוטים משימה. מתעדכנים מכל מכשיר.",
      getStarted: "להתחיל",
      download: {
        mac: "הורדה ל-macOS",
        windows: "הורדה ל-Windows",
        linux: "הורדה ל-Linux",
        ios: "הורדה ל-iOS",
        android: "הורדה ל-Android",
      },
      viewOnGithub: "צפייה ב-GitHub",
      setupWithAgent: "הגדרה עם הסוכן שלך",
      copiedForAgent: "הועתק עבור הסוכן שלך",
      copyFailed: "ההעתקה נכשלה. אפשר לנסות שוב.",
    },
    selfHost: {
      heading: "באירוח עצמי",
      copy: "המכונה שלך, המודלים שלך, השליטה שלך.",
      worksWith: "עובד עם",
      mock: {
        weekdays: "שני עד שישי ב-9:00",
        approval: "נדרש אישור",
        approve: "אישור",
        deny: "דחייה",
      },
      features: [
        { title: "המודל שלך", body: "אפשר לבחור מודל אחר לכל בוט." },
        { title: "עבודה לפי לוח זמנים", body: "ממשיך לעבוד גם כשהמחשב שלך כבוי." },
        { title: "הגבולות בידיים שלך", body: "קובעים אילו פעולות דורשות את האישור שלך." },
      ],
    },
    platforms: {
      heading: "בכל מקום",
      web: "ווב",
      desktop: "דסקטופ",
      mobile: "מובייל",
    },
    channels: {
      heading: "שולחים להם הודעה מכל מקום",
      copy: "מתייגים בוט ב-Slack או שולחים לו הודעה מהטלפון.",
      mock: { ask: "למי צריך לחזור היום?", reply: "שלושה לידים השתתקו השבוע. הטיוטות בשרשור." },
    },
    features: {
      heading: "יותר מצ'אט",
      items: {
        call: {
          title: "שיחות ופגישות",
          body: "הבוט יכול להתקשר אליך באפליקציה ולהצטרף לפגישות ב-Zoom או ב-Google Meet כדי לתמלל אותן.",
        },
        apps: {
          title: "עובד באפליקציות שלך",
          body: "אפשר לחבר את Gmail, GitHub, Notion וכל שרת MCP.",
        },
        memory: { title: "זוכר", body: "הבוטים שומרים את מה שהם לומדים ומשתפים את זה עם הצוות." },
        triggers: {
          title: "מתעורר מעצמו",
          body: "לפי לוח זמנים, דרך Webhook, באירוע GitHub או כשמשהו שהוא עוקב אחריו משתנה.",
        },
        team: {
          title: "מעביר עבודה הלאה",
          body: "הבוטים מאצילים משימות זה לזה ועובדים יחד בקבוצות.",
        },
        teach: {
          title: "לומד מצפייה",
          body: "מראים לו משימה פעם אחת במחשב שלו. הוא שומר את השלבים כמיומנות.",
        },
      },
      mock: {
        calling: "מתקשר…",
        memory: "זיכרון",
        memoryNotes: ["מעדיף תשובות קצרות", "Acme מחדשת במרץ"],
        triggers: ["שני עד שישי ב-9:00", "Issue חדש ב-GitHub", "Webhook"],
        recording: "מקליט",
        skillSaved: "נשמר כמיומנות",
      },
    },
    faq: {
      heading: "שאלות נפוצות",
      items: [
        {
          question: "אפשר להשתמש במנוי Claude Pro/Max או ChatGPT Plus/Pro שלי?",
          answer:
            "כן. התחברו עם ChatGPT בתוכנית מתאימה. כדי להשתמש ב-Claude Pro או Max, ארחו את Superbot מקוד המקור לשימושכם בלבד והריצו אותו דרך ה-CLI הרשמי של Claude Code, מחובר לחשבון שלכם. אפשר גם לחבר מפתח API. פרטים נוספים בעמוד Model subscriptions בתיעוד.",
        },
        {
          question: "אפשר להריץ מודל מקומי?",
          answer:
            "כן. מכוונים בוט לשרת מקומי תואם OpenAI כמו Ollama או LM Studio. כל בוט יכול להשתמש במודל אחר.",
        },
      ],
    },
    openSource: {
      heading: "קוד פתוח",
      copy: "Apache-2.0. אפשר להריץ, לשנות ולהתאים לעצמך.",
      starOnGithub: "סימון בכוכב ב-GitHub",
      readTheDocs: "לקריאת התיעוד",
      cloudTitle: "ענן",
      cloudBadge: "בטא",
    },
    cta: {
      heading: "הכירו את הבוט הראשון שלכם",
      copy: "העבירו לו את המשימה הבאה.",
      openSourceValue: "קוד פתוח",
      selfHostValue: "אירוח עצמי",
      stats: [
        { value: "stars", label: "כוכבים ב-GitHub" },
        { value: "license", label: "רישיון" },
        { value: "openSource", label: "כל הפיצ׳רים, בחינם" },
        { value: "selfHost", label: "המכונה שלך" },
      ],
    },
    footer: {
      navLabel: "כותרת תחתונה",
      languagesLabel: "שפה",
      links: {
        docs: "תיעוד",
        product: "מוצר",
        changelog: "יומן שינויים",
        download: "הורדה",
      },
    },
  },
  hi: {
    title: "Superbot | Grok Bot का ओपन सोर्स विकल्प",
    description:
      "Superbot, Grok Bot का ओपन सोर्स विकल्प है, ऐसे स्थायी AI साथियों के लिए जो असली काम करते हैं। आपकी कुंजियाँ, आपका मॉडल, आपकी मशीन।",
    ogImageAlt: "Superbot. ऐसे AI साथी जो सच में आपके अपने हैं। आपकी कुंजियाँ, आपका मॉडल, आपकी मशीन।",
    availableLanguage: "Hindi",
    skipToContent: "सामग्री पर जाएं",
    nav: {
      home: "Superbot होम",
      primary: "मुख्य नेविगेशन",
      menu: "मेनू",
      docs: "दस्तावेज़",
      github: "GitHub",
      getStarted: "शुरू करें",
    },
    hero: {
      eyebrow: "ओपन सोर्स",
      heading: "Grok Bot का ओपन सोर्स विकल्प, जो सच में आपका अपना है",
      lead: "अपने बॉट्स को काम दें। किसी भी डिवाइस से हाल देखें।",
      getStarted: "शुरू करें",
      download: {
        mac: "macOS के लिए डाउनलोड करें",
        windows: "Windows के लिए डाउनलोड करें",
        linux: "Linux के लिए डाउनलोड करें",
        ios: "iOS के लिए डाउनलोड करें",
        android: "Android के लिए डाउनलोड करें",
      },
      viewOnGithub: "GitHub पर देखें",
      setupWithAgent: "अपने एजेंट से सेट अप करें",
      copiedForAgent: "आपके एजेंट के लिए कॉपी किया गया",
      copyFailed: "कॉपी नहीं हो सका। फिर से कोशिश करें।",
    },
    selfHost: {
      heading: "सेल्फ़-होस्टेड",
      copy: "आपकी मशीन, आपके मॉडल, आपका नियंत्रण।",
      worksWith: "इनके साथ काम करता है",
      mock: {
        weekdays: "कार्यदिवस, 9:00 बजे",
        approval: "अनुमोदन ज़रूरी",
        approve: "अनुमोदित करें",
        deny: "अस्वीकार करें",
      },
      features: [
        { title: "आपका मॉडल", body: "हर बॉट के लिए अलग मॉडल चुनें।" },
        { title: "शेड्यूल पर काम", body: "आपका कंप्यूटर बंद होने पर भी काम चलता रहता है।" },
        { title: "सीमाएं आप तय करें", body: "तय करें कि किन कार्रवाइयों के लिए आपका अनुमोदन चाहिए।" },
      ],
    },
    platforms: {
      heading: "आप जहां भी हों",
      web: "वेब",
      desktop: "डेस्कटॉप",
      mobile: "मोबाइल",
    },
    channels: {
      heading: "कहीं से भी मैसेज करें",
      copy: "Slack में किसी बॉट को मेंशन करें या अपने फ़ोन से उसे मैसेज भेजें।",
      mock: {
        ask: "आज किसे फ़ॉलो-अप चाहिए?",
        reply: "इस हफ़्ते तीन लीड्स ने जवाब देना बंद कर दिया। ड्राफ़्ट थ्रेड में हैं।",
      },
    },
    features: {
      heading: "चैट से कहीं ज़्यादा",
      items: {
        call: {
          title: "कॉल और मीटिंग",
          body: "आपका बॉट ऐप में आपको कॉल कर सकता है और Zoom या Google Meet की मीटिंग का लिखित रिकॉर्ड बना सकता है।",
        },
        apps: {
          title: "आपके ऐप्स में काम करता है",
          body: "Gmail, GitHub, Notion और किसी भी MCP सर्वर से कनेक्ट करें।",
        },
        memory: {
          title: "याद रखता है",
          body: "बॉट्स जो सीखते हैं उसे याद रखते हैं और टीम के साथ शेयर करते हैं।",
        },
        triggers: {
          title: "अपने आप जाग जाता है",
          body: "शेड्यूल पर, Webhook से, GitHub इवेंट पर, या जिस चीज़ पर वह नज़र रखता है उसमें बदलाव होने पर।",
        },
        team: {
          title: "काम आगे सौंपता है",
          body: "बॉट्स एक-दूसरे को काम सौंपते हैं और समूहों में साथ काम करते हैं।",
        },
        teach: {
          title: "देखकर सीखता है",
          body: "उसके कंप्यूटर पर एक बार काम करके दिखाएं। वह उन स्टेप्स को स्किल के रूप में सहेज लेता है।",
        },
      },
      mock: {
        calling: "कॉल हो रही है…",
        memory: "मेमोरी",
        memoryNotes: ["छोटे जवाब पसंद हैं", "Acme का रिन्यूअल मार्च में है"],
        triggers: ["कार्यदिवस, 9:00 बजे", "नया GitHub issue", "Webhook"],
        recording: "रिकॉर्डिंग",
        skillSaved: "स्किल के रूप में सहेजा गया",
      },
    },
    faq: {
      heading: "अक्सर पूछे जाने वाले सवाल",
      items: [
        {
          question: "क्या मेरा Claude Pro/Max या ChatGPT Plus/Pro सब्सक्रिप्शन इस्तेमाल हो सकता है?",
          answer:
            "हाँ। योग्य प्लान के साथ ChatGPT से साइन इन करें। Claude Pro या Max इस्तेमाल करने के लिए Superbot को सोर्स कोड से सिर्फ़ अपने लिए खुद होस्ट करें और अपने खाते से साइन इन किए गए आधिकारिक Claude Code CLI के ज़रिए चलाएँ। आप API कुंजी भी जोड़ सकते हैं। विवरण के लिए डॉक्स में Model subscriptions देखें।",
        },
        {
          question: "क्या लोकल मॉडल चलाया जा सकता है?",
          answer:
            "हाँ। बॉट को Ollama या LM Studio जैसे किसी लोकल OpenAI-संगत सर्वर से जोड़ें। हर बॉट अलग मॉडल इस्तेमाल कर सकता है।",
        },
      ],
    },
    openSource: {
      heading: "ओपन सोर्स",
      copy: "Apache-2.0. इसे चलाएं, बदलें, अपने हिसाब से बनाएं।",
      starOnGithub: "GitHub पर स्टार करें",
      readTheDocs: "दस्तावेज़ पढ़ें",
      cloudTitle: "क्लाउड",
      cloudBadge: "बीटा",
    },
    cta: {
      heading: "अपने पहले बॉट से मिलें",
      copy: "अपना अगला काम सौंप दें।",
      openSourceValue: "ओपन सोर्स",
      selfHostValue: "सेल्फ़-होस्ट",
      stats: [
        { value: "stars", label: "GitHub स्टार्स" },
        { value: "license", label: "लाइसेंस" },
        { value: "openSource", label: "सभी फ़ीचर, मुफ़्त" },
        { value: "selfHost", label: "आपकी मशीन" },
      ],
    },
    footer: {
      navLabel: "फ़ुटर",
      languagesLabel: "भाषा",
      links: {
        docs: "दस्तावेज़",
        product: "प्रोडक्ट",
        changelog: "चेंजलॉग",
        download: "डाउनलोड",
      },
    },
  },
  "zh-tw": {
    title: "Superbot | 開源 Grok Bot 替代方案",
    description:
      "Superbot 是開源的 Grok Bot 替代方案，讓常駐的 AI 隊友幫你完成實際工作。金鑰、模型、機器，全都屬於你。",
    ogImageAlt: "Superbot：真正屬於你的 AI 隊友。金鑰、模型、機器，全都屬於你。",
    availableLanguage: "Chinese (Traditional)",
    skipToContent: "跳至主要內容",
    nav: {
      home: "Superbot 首頁",
      primary: "主要導覽",
      menu: "選單",
      docs: "說明文件",
      github: "GitHub",
      getStarted: "開始使用",
    },
    hero: {
      eyebrow: "開源",
      heading: "真正屬於你的開源 Grok Bot 替代方案",
      lead: "把工作交給機器人，用任何裝置隨時查看。",
      getStarted: "開始使用",
      download: {
        mac: "下載 macOS 版",
        windows: "下載 Windows 版",
        linux: "下載 Linux 版",
        ios: "下載 iOS 版",
        android: "下載 Android 版",
      },
      viewOnGithub: "在 GitHub 上查看",
      setupWithAgent: "用你的代理程式設定",
      copiedForAgent: "已為你的代理程式複製",
      copyFailed: "複製失敗，請重試。",
    },
    selfHost: {
      heading: "自行託管",
      copy: "機器、模型、控制權，都由你掌握。",
      worksWith: "支援",
      mock: { weekdays: "工作日 9:00", approval: "需要核准", approve: "核准", deny: "拒絕" },
      features: [
        { title: "自選模型", body: "為每個機器人選擇不同的模型。" },
        { title: "依排程執行", body: "電腦關機時也照常工作。" },
        { title: "由你設定界線", body: "決定哪些動作需要你核准。" },
      ],
    },
    platforms: {
      heading: "隨時隨地",
      web: "網頁版",
      desktop: "桌面版",
      mobile: "行動版",
    },
    channels: {
      heading: "隨處傳訊息",
      copy: "在 Slack 中提及機器人，或用手機傳訊息給它。",
      mock: { ask: "今天該跟進誰？", reply: "這週有三個潛在客戶沒有回音。草稿已放在討論串裡。" },
    },
    features: {
      heading: "不只是聊天",
      items: {
        call: {
          title: "通話和會議",
          body: "機器人可以在 App 裡打電話給你，也能加入 Zoom 或 Google Meet 並產生逐字稿。",
        },
        apps: {
          title: "在你的 App 裡工作",
          body: "連接 Gmail、GitHub、Notion 和任何 MCP 伺服器。",
        },
        memory: { title: "記得住", body: "機器人會記住學到的東西，並與團隊分享。" },
        triggers: { title: "自動啟動", body: "依排程、Webhook、GitHub 事件，或它關注的變化觸發。" },
        team: { title: "分派工作", body: "機器人彼此委派工作，也能在群組中協作。" },
        teach: { title: "看一次就會", body: "在它的電腦上示範一次任務，它會把步驟存成技能。" },
      },
      mock: {
        calling: "撥號中…",
        memory: "記憶",
        memoryNotes: ["偏好簡短回覆", "Acme 三月續約"],
        triggers: ["工作日 9:00", "新的 GitHub issue", "Webhook"],
        recording: "錄製中",
        skillSaved: "已存成技能",
      },
    },
    faq: {
      heading: "常見問題",
      items: [
        {
          question: "可以用我的 Claude Pro/Max 或 ChatGPT Plus/Pro 訂閱嗎？",
          answer:
            "可以。使用符合資格的方案登入 ChatGPT。若要使用 Claude Pro 或 Max，請從原始碼自行託管僅供你本人使用的 Superbot，並透過以你的帳號登入的官方 Claude Code CLI 執行。你也可以連接 API 金鑰。詳情請見文件中的 Model subscriptions。",
        },
        {
          question: "可以執行本機模型嗎？",
          answer:
            "可以。將機器人指向 Ollama 或 LM Studio 等本機 OpenAI 相容伺服器。每個機器人都可以使用不同的模型。",
        },
      ],
    },
    openSource: {
      heading: "開源",
      copy: "Apache-2.0。自由執行、修改，打造成你要的樣子。",
      starOnGithub: "在 GitHub 上加星號",
      readTheDocs: "閱讀說明文件",
      cloudTitle: "雲端",
      cloudBadge: "Beta 版",
    },
    cta: {
      heading: "認識你的第一個機器人",
      copy: "把下一項任務交給它。",
      openSourceValue: "開源",
      selfHostValue: "自行託管",
      stats: [
        { value: "stars", label: "GitHub 星號" },
        { value: "license", label: "授權" },
        { value: "openSource", label: "全部功能，免費使用" },
        { value: "selfHost", label: "你的機器" },
      ],
    },
    footer: {
      navLabel: "頁尾",
      languagesLabel: "語言",
      links: {
        docs: "說明文件",
        product: "產品",
        changelog: "更新紀錄",
        download: "下載",
      },
    },
  },
};

export function getHomeCopy(locale: Locale): HomeCopy {
  return HOME_COPY[locale];
}
