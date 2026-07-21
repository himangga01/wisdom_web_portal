import { CONSULTATION_CATEGORIES, LOCALES, type Locale } from "@wisdom/shared";

export const OFFICE = {
  name: "지혜행정사사무소",
  englishName: "JIHYE Administrative Attorney",
  representative: "강지혜 행정사",
  phone: "010-8415-0023",
  fax: "0504-051-0023",
  email: "kjihye0023@naver.com",
  address: "서울특별시 송파구 법원로 92, 212호 (문정동, 파트너스1)",
  blogUrl: "https://m.blog.naver.com/wisdom_jhk",
  mapUrl: "https://naver.me/GprFCirq",
} as const;

export const REPRESENTATIVE = {
  education: [
    "한양대학교 경영학 학사·석사",
    "아주대학교 대학원 교육학·상담 석사",
    "남서울대학교 AI공공조달학 석사과정",
  ],
  career: ["공공조달연구소 이사"],
  qualifications: ["제11회 행정사", "ISO 45001 심사원"],
} as const;

type ConsultationCategory = (typeof CONSULTATION_CATEGORIES)[number];
export type ServiceCategorySlug = Exclude<ConsultationCategory, "other">;

export const SERVICE_CATEGORY_SLUGS = CONSULTATION_CATEGORIES.filter(
  (slug): slug is ServiceCategorySlug => slug !== "other",
);

const PAGE_KEYS = [
  "home",
  "about",
  "services",
  "process",
  "insights",
  "consultation",
  "location",
  "privacy",
  "marketingWithdraw",
  "notFound",
] as const;

type PageKey = (typeof PAGE_KEYS)[number];

interface ServiceCategoryTranslation {
  title: string;
  summary: string;
  items: readonly string[];
}

interface ServiceCategoryContent extends ServiceCategoryTranslation {
  slug: ServiceCategorySlug;
}

interface LocalePageNarrative {
  home: {
    eyebrow: string;
    intro: string;
    navigatorTitle: string;
    navigatorBody: string;
    principlesTitle: string;
    principles: readonly { title: string; body: string }[];
    insightsTitle: string;
    insights: readonly { title: string; body: string }[];
    credentialsTitle: string;
    credentialsBody: string;
    consultationTitle: string;
    consultationBody: string;
    portraitLabel: string;
    sectionLabels: {
      navigator: string;
      principles: string;
      profile: string;
    };
    insightCategories: readonly [string, string, string];
  };
  about: {
    intro: string;
    educationHeading: string;
    careerHeading: string;
    qualificationsHeading: string;
    disclosure: string;
  };
  profile: {
    education: readonly string[];
    career: readonly string[];
    qualifications: readonly string[];
  };
  servicesIntro: string;
  process: {
    intro: string;
    steps: readonly { title: string; body: string }[];
  };
  insights: {
    intro: string;
    note: string;
  };
  consultationIntro: string;
  locationIntro: string;
  privacy: {
    intro: string;
    support: string;
  };
  marketingWithdraw: {
    intro: string;
    steps: readonly string[];
    support: string;
  };
  notFoundBody: string;
  formOptions: {
    phone: string;
    email: string;
    other: string;
  };
}

interface LocaleText {
  navigation: {
    home: string;
    about: string;
    services: string;
    process: string;
    insights: string;
    consultation: string;
    location: string;
  };
  accessibility: {
    skipToContent: string;
    primaryNavigation: string;
    mobileNavigation: string;
    openMenu: string;
    languageSelection: string;
    additionalContactOptions: string;
  };
  buttons: {
    consultation: string;
    phone: string;
    kakao: string;
    blog: string;
    map: string;
    exploreServices: string;
    backHome: string;
  };
  headings: Record<PageKey, string>;
  metaDescriptions: Record<PageKey, string>;
  home: {
    pillars: readonly {
      title: string;
      summary: string;
    }[];
  };
  forms: {
    consultation: {
        labels: {
          consent: string;
          website: string;
          locale: string;
        category: string;
        categoryPlaceholder: string;
        name: string;
        phone: string;
        email: string;
        company: string;
        preferredContact: string;
        message: string;
        privacyConsent: string;
        marketingConsent: string;
      };
      help: {
        category: string;
        phone: string;
        email: string;
        company: string;
        preferredContact: string;
        message: string;
        privacyConsent: string;
        marketingConsent: string;
        sensitiveIdWarning: string;
          noAttachments: string;
          noJavaScript: string;
          consentVersion: string;
          consentEffectiveAt: string;
          consentRetention: string;
          consentMonths: string;
      };
      errors: {
        required: string;
        invalidPhone: string;
        invalidEmail: string;
        messageLength: string;
        privacyRequired: string;
        };
        status: {
          submitting: string;
          success: string;
          failure: string;
          configurationFailure: string;
          consentReady: string;
          consentUpdated: string;
          consentLoading: string;
          sessionRefreshed: string;
          invalid: string;
        };
        submit: string;
        retryConsent: string;
    };
  };
  footer: {
    office: string;
    representative: string;
    contact: string;
    privacy: string;
      marketingWithdraw: string;
      policies: string;
      rights: string;
  };
  office: {
    name: string;
    englishName: string;
    representative: string;
    phone: string;
    fax: string;
    email: string;
    address: string;
    nearby: string;
    addressLabel: string;
    phoneLabel: string;
    faxLabel: string;
    emailLabel: string;
  };
  policies: {
    privacyHeading: string;
    marketingWithdrawHeading: string;
  };
  serviceCatalog: Record<ServiceCategorySlug, ServiceCategoryTranslation>;
}

interface LocaleSiteContent extends Omit<LocaleText, "metaDescriptions" | "serviceCatalog"> {
  meta: Record<PageKey, { title: string; description: string }>;
  pages: LocalePageNarrative;
  services: {
    categories: readonly ServiceCategoryContent[];
  };
}

const localizedText = {
  ko: {
    navigation: {
      home: "홈",
      about: "사무소 소개",
      services: "업무 분야",
      process: "진행 절차",
      insights: "실무 안내",
      consultation: "상담 신청",
      location: "오시는 길",
    },
    accessibility: {
      skipToContent: "본문으로 이동",
      primaryNavigation: "주요 메뉴",
      mobileNavigation: "모바일 메뉴",
      openMenu: "메뉴 열기",
      languageSelection: "언어 선택",
      additionalContactOptions: "추가 연락 방법",
    },
    buttons: {
      consultation: "상담 신청",
      phone: "전화하기",
      kakao: "카카오톡 상담",
      blog: "네이버 블로그",
      map: "네이버 지도",
      exploreServices: "업무 분야 살펴보기",
      backHome: "홈으로 돌아가기",
    },
    headings: {
      home: "기업행정·공공조달·출입국 비자",
      about: "지혜행정사사무소 소개",
      services: "업무 분야",
      process: "업무 진행 절차",
      insights: "행정 실무 안내",
      consultation: "상담 신청",
      location: "오시는 길",
      privacy: "개인정보 처리방침",
      marketingWithdraw: "마케팅 수신 동의 철회",
      notFound: "페이지를 찾을 수 없습니다",
    },
    metaDescriptions: {
      home: "기업행정, 공공조달, 출입국·비자 업무를 안내합니다.",
      about: "강지혜 행정사와 지혜행정사사무소의 전문 분야를 소개합니다.",
      services: "여섯 분야의 행정사 업무와 세부 서비스를 확인합니다.",
      process: "상담부터 업무 진행까지의 기본 절차를 안내합니다.",
      insights: "기업행정, 조달, 출입국 실무 안내를 확인합니다.",
      consultation: "상담에 필요한 기본 정보를 안전하게 전달합니다.",
      location: "문정역 인근 사무소 주소와 연락처를 안내합니다.",
      privacy: "현재 적용 중인 개인정보 수집·이용 동의 문서를 확인합니다.",
      marketingWithdraw: "마케팅 수신 동의 철회 방법을 안내합니다.",
      notFound: "요청한 페이지를 찾을 수 없습니다.",
    },
    home: {
      pillars: [
        { title: "기업행정", summary: "기업인증, 인허가, 법인·단체 설립을 검토합니다." },
        { title: "공공조달", summary: "조달시장 진입과 제품·기업 인증을 지원합니다." },
        { title: "출입국·비자", summary: "취업·투자·가족·체류 업무를 안내합니다." },
      ],
    },
    forms: {
      consultation: {
        labels: {
          consent: "동의",
          website: "웹사이트(비워 두세요)",
          locale: "상담 언어",
          category: "상담 분야",
          categoryPlaceholder: "분야를 선택해 주세요",
          name: "이름",
          phone: "전화번호",
          email: "이메일",
          company: "회사·기관명",
          preferredContact: "선호 연락 방법",
          message: "상담 내용",
          privacyConsent: "개인정보 수집·이용 동의",
          marketingConsent: "마케팅 정보 수신 동의",
        },
        help: {
          category: "가장 가까운 업무 분야를 선택해 주세요.",
          phone: "연락 가능한 번호를 입력해 주세요.",
          email: "이메일 연락 또는 마케팅 수신을 선택하면 필수입니다.",
          company: "해당하는 경우에만 입력해 주세요.",
          preferredContact: "전화 또는 이메일 중 하나를 선택해 주세요.",
          message: "검토할 사실관계와 원하는 도움을 20자 이상 작성해 주세요.",
          privacyConsent: "상담 접수를 위해 필수입니다.",
          marketingConsent: "선택 항목이며 기본값은 동의하지 않음입니다.",
          sensitiveIdWarning: "주민등록번호, 여권번호, 외국인등록번호 등 민감한 식별정보는 입력하지 마세요.",
          noAttachments: "이 단계에서는 첨부파일을 받지 않습니다.",
          noJavaScript: "온라인 접수에는 JavaScript가 필요합니다. 사용할 수 없다면 전화 또는 이메일로 문의해 주세요.",
          consentVersion: "문서 버전",
          consentEffectiveAt: "시행일",
          consentRetention: "보유기간",
          consentMonths: "개월",
        },
        errors: {
          required: "필수 항목을 입력해 주세요.",
          invalidPhone: "올바른 전화번호를 입력해 주세요.",
          invalidEmail: "올바른 이메일 주소를 입력해 주세요.",
          messageLength: "상담 내용은 20자 이상 2,000자 이하로 입력해 주세요.",
          privacyRequired: "개인정보 수집·이용에 동의해야 상담을 접수할 수 있습니다.",
        },
        status: {
          submitting: "상담 요청을 보내는 중입니다…",
          success: "상담 요청이 접수되었습니다. 접수번호 {receiptId} 를 보관해 주세요. 영업일 기준 1~2일 내에 선택하신 방법으로 연락드립니다.",
          failure: "현재 상담 요청을 전송할 수 없습니다. 잠시 후 다시 시도해 주세요.",
          configurationFailure: "최신 동의 문서를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
          consentReady: "최신 동의 문서를 불러왔습니다. 내용을 확인하고 동의해 주세요.",
          consentUpdated: "동의 문서가 변경되었습니다. 최신 내용을 확인한 뒤 다시 동의해 주세요.",
          consentLoading: "동의 문서를 불러오는 중입니다. 잠시만 기다려 주세요.",
          sessionRefreshed: "화면이 오래 열려 있어 접수 준비를 새로 했습니다. 내용을 확인한 뒤 다시 제출해 주세요.",
          invalid: "입력 내용을 다시 확인해 주세요.",
        },
        submit: "상담 요청 보내기",
        retryConsent: "동의 문서 다시 불러오기",
      },
    },
    footer: {
      office: "지혜행정사사무소",
      representative: "대표 강지혜 행정사",
      contact: "연락처",
      privacy: "개인정보 처리방침",
      marketingWithdraw: "마케팅 수신 동의 철회",
      policies: "운영 안내",
      rights: "모든 권리 보유.",
    },
    office: {
      name: OFFICE.name,
      englishName: OFFICE.englishName,
      representative: OFFICE.representative,
      phone: OFFICE.phone,
      fax: OFFICE.fax,
      email: OFFICE.email,
      address: OFFICE.address,
      nearby: "문정역 인근",
      addressLabel: "주소",
      phoneLabel: "전화",
      faxLabel: "팩스",
      emailLabel: "이메일",
    },
    policies: {
      privacyHeading: "개인정보 처리방침",
      marketingWithdrawHeading: "마케팅 수신 동의 철회",
    },
    serviceCatalog: {
      procurement: {
        title: "공공조달",
        summary: "조달시장 진입에 필요한 생산·제품 확인과 등록을 지원합니다.",
        items: ["직접생산확인증명", "공장등록", "다수공급자계약(MAS)", "혁신제품", "우수조달물품"],
      },
      credibility: {
        title: "기업 신뢰도 인증",
        summary: "기업의 공공성과 품질, 고용 가치를 입증하는 인증을 지원합니다.",
        items: [
          "가족친화인증",
          "G-PASS 기업 지정",
          "GS 인증",
          "KS·단체표준 인증",
          "성능인증",
          "여성기업 확인",
          "장애인 표준사업장 인증",
          "사회적협동조합",
          "일·생활 균형 우수기업",
        ],
      },
      "safety-esg": {
        title: "안전·ESG",
        summary: "안전, 사회적 책임, 지속가능경영 관련 준비를 지원합니다.",
        items: ["SH평가", "SA평가", "ESG평가", "안전보건계획서 작성"],
      },
      "business-certification": {
        title: "기업 인증",
        summary: "성장 단계와 사업 목적에 맞는 기업·연구 인증을 지원합니다.",
        items: [
          "벤처기업 확인",
          "이노비즈 인증",
          "메인비즈 인증",
          "기업부설연구소·연구개발전담부서",
          "ISO 인증",
          "병역지정업체 선정",
        ],
      },
      "licensing-entity": {
        title: "인허가·법인·단체",
        summary: "사업 인허가와 비영리 법인·단체 설립 절차를 지원합니다.",
        items: [
          "평생교육시설 신고",
          "여행업 등록",
          "비영리 사단법인·재단법인 설립",
          "공익법인 지정",
          "민간자격 등록",
          "화장품 제조업 등록",
          "화장품 책임판매업 등록",
        ],
      },
      "immigration-visa": {
        title: "출입국·비자",
        summary: "취업, 투자, 가족, 공연, 국적과 체류 업무를 지원합니다.",
        items: [
          "E-7 특정활동",
          "E-6 예술흥행",
          "F-4·F-1·F-2·F-5·F-6",
          "C-3 단기방문",
          "C-4 단기취업",
          "D-10 구직",
          "D-7 주재",
          "D-8 기업투자",
          "공연비자",
          "국적회복",
          "영주권",
          "체류기간 연장",
        ],
      },
    },
  },
  en: {
    navigation: {
      home: "Home",
      about: "About",
      services: "Services",
      process: "Process",
      insights: "Insights",
      consultation: "Consultation",
      location: "Location",
    },
    accessibility: {
      skipToContent: "Skip to content",
      primaryNavigation: "Primary navigation",
      mobileNavigation: "Mobile navigation",
      openMenu: "Open menu",
      languageSelection: "Language selection",
      additionalContactOptions: "Additional contact options",
    },
    buttons: {
      consultation: "Request a consultation",
      phone: "Call",
      kakao: "KakaoTalk",
      blog: "Naver Blog",
      map: "Naver Map",
      exploreServices: "Explore services",
      backHome: "Back to home",
    },
    headings: {
      home: "Business Administration, Public Procurement & Immigration",
      about: "About JIHYE Administrative Attorney",
      services: "Services",
      process: "How We Work",
      insights: "Practical Insights",
      consultation: "Request a Consultation",
      location: "Location",
      privacy: "Privacy Policy",
      marketingWithdraw: "Withdraw Marketing Consent",
      notFound: "Page Not Found",
    },
    metaDescriptions: {
      home: "Guidance for business administration, public procurement, and immigration matters.",
      about: "Learn about Jihye Kang and the practice areas of JIHYE Administrative Attorney.",
      services: "Review six service groups and their administrative procedures.",
      process: "See the basic process from initial consultation through engagement.",
      insights: "Read practical guidance on business, procurement, and immigration matters.",
      consultation: "Send the basic information needed to review your consultation request.",
      location: "Find the office near Munjeong Station and view contact details.",
      privacy: "Review the active privacy consent document used for consultation intake.",
      marketingWithdraw: "Learn how to withdraw marketing communications consent.",
      notFound: "The requested page could not be found.",
    },
    home: {
      pillars: [
        { title: "Business Administration", summary: "Business certification, licensing, and entity formation." },
        { title: "Public Procurement", summary: "Market entry and product or company certification." },
        { title: "Immigration & Visas", summary: "Employment, investment, family, and stay matters." },
      ],
    },
    forms: {
      consultation: {
        labels: {
          consent: "Consent",
          website: "Website (leave blank)",
          locale: "Consultation language",
          category: "Service category",
          categoryPlaceholder: "Please choose a category",
          name: "Name",
          phone: "Phone",
          email: "Email",
          company: "Company or organization",
          preferredContact: "Preferred contact method",
          message: "Consultation details",
          privacyConsent: "Consent to collection and use of personal information",
          marketingConsent: "Consent to marketing communications",
        },
        help: {
          category: "Choose the service category that best matches your request.",
          phone: "Enter a number where you can be reached.",
          email: "Required when email contact or marketing communications are selected.",
          company: "Complete this field only when applicable.",
          preferredContact: "Choose phone or email.",
          message: "Describe the relevant facts and requested help in at least 20 characters.",
          privacyConsent: "Required to submit a consultation request.",
          marketingConsent: "Optional and unchecked by default.",
          sensitiveIdWarning: "Do not enter resident, passport, or foreign registration numbers or other sensitive identifiers.",
          noAttachments: "Attachments are not accepted at this stage.",
          noJavaScript: "JavaScript is required for secure online submission. If it is unavailable, contact the office by phone or email.",
          consentVersion: "Document version",
          consentEffectiveAt: "Effective date",
          consentRetention: "Retention period",
          consentMonths: "months",
        },
        errors: {
          required: "Complete this required field.",
          invalidPhone: "Enter a valid phone number.",
          invalidEmail: "Enter a valid email address.",
          messageLength: "Enter between 20 and 2,000 characters.",
          privacyRequired: "Privacy consent is required to submit the request.",
        },
        status: {
          submitting: "Sending your consultation request…",
          success: "Your consultation request was received. Please keep your receipt number {receiptId}. We will contact you through your preferred method within 1–2 business days.",
          failure: "We could not send your consultation request. Please try again shortly.",
          configurationFailure: "We could not load the current consent documents. Please try again shortly.",
          consentReady: "The current consent documents are ready. Review them before giving consent.",
          consentUpdated: "The consent documents changed. Review the current text and consent again.",
          consentLoading: "Loading the consent documents. Please wait a moment.",
          sessionRefreshed: "This page was open for a while, so the form was refreshed. Please review and submit again.",
          invalid: "Review the form fields and try again.",
        },
        submit: "Send consultation request",
        retryConsent: "Retry loading consent documents",
      },
    },
    footer: {
      office: "JIHYE Administrative Attorney",
      representative: "Administrative Attorney Jihye Kang",
      contact: "Contact",
      privacy: "Privacy Policy",
      marketingWithdraw: "Withdraw Marketing Consent",
      policies: "Policies",
      rights: "All rights reserved.",
    },
    office: {
      name: "JIHYE Administrative Attorney",
      englishName: OFFICE.englishName,
      representative: "Administrative Attorney Jihye Kang",
      phone: OFFICE.phone,
      fax: OFFICE.fax,
      email: OFFICE.email,
      address: "Suite 212, 92 Beobwon-ro, Songpa-gu, Seoul (Partners 1, Munjeong-dong)",
      nearby: "Near Munjeong Station",
      addressLabel: "Address",
      phoneLabel: "Phone",
      faxLabel: "Fax",
      emailLabel: "Email",
    },
    policies: {
      privacyHeading: "Privacy Policy",
      marketingWithdrawHeading: "Withdraw Marketing Consent",
    },
    serviceCatalog: {
      procurement: {
        title: "Public Procurement",
        summary: "Production, product, and registration support for entering public procurement.",
        items: [
          "Direct production certificate",
          "Factory registration",
          "Multiple Award Schedule (MAS)",
          "Innovative product",
          "Excellent procurement product",
        ],
      },
      credibility: {
        title: "Business Credibility",
        summary: "Certifications that demonstrate quality, public value, and employment practices.",
        items: [
          "Family-friendly certification",
          "G-PASS designation",
          "GS certification",
          "KS or group standard certification",
          "Performance certification",
          "Women-owned business confirmation",
          "Standard workplace for people with disabilities",
          "Social cooperative",
          "Work-life balance excellence",
        ],
      },
      "safety-esg": {
        title: "Safety & ESG",
        summary: "Preparation for safety, social responsibility, and sustainability requirements.",
        items: [
          "SH assessment",
          "SA assessment",
          "ESG assessment",
          "Occupational safety and health plan preparation",
        ],
      },
      "business-certification": {
        title: "Business Certification",
        summary: "Company and research certifications aligned with business goals.",
        items: [
          "Venture business confirmation",
          "Innobiz certification",
          "Mainbiz certification",
          "Company research institute or R&D department",
          "ISO certification",
          "Military service designated company",
        ],
      },
      "licensing-entity": {
        title: "Licensing & Entities",
        summary: "Licensing and establishment procedures for businesses and nonprofit entities.",
        items: [
          "Lifelong education facility",
          "Travel business registration",
          "Nonprofit association or foundation",
          "Public-interest corporation designation",
          "Private qualification registration",
          "Cosmetics manufacturing registration",
          "Responsible cosmetics sales registration",
        ],
      },
      "immigration-visa": {
        title: "Immigration & Visas",
        summary: "Employment, investment, family, performance, nationality, and stay matters.",
        items: [
          "E-7 visa",
          "E-6 visa",
          "F-4, F-1, F-2, F-5, or F-6 visa",
          "C-3 visa",
          "C-4 visa",
          "D-10 visa",
          "D-7 visa",
          "D-8 visa",
          "Performance visa",
          "Nationality restoration",
          "Permanent residence",
          "Extension of stay",
        ],
      },
    },
  },
  "zh-Hans": {
    navigation: {
      home: "首页",
      about: "事务所介绍",
      services: "业务领域",
      process: "办理流程",
      insights: "实务指南",
      consultation: "申请咨询",
      location: "来访路线",
    },
    accessibility: {
      skipToContent: "跳至主要内容",
      primaryNavigation: "主要导航",
      mobileNavigation: "移动端导航",
      openMenu: "打开菜单",
      languageSelection: "选择语言",
      additionalContactOptions: "其他联系方式",
    },
    buttons: {
      consultation: "申请咨询",
      phone: "电话联系",
      kakao: "KakaoTalk咨询",
      blog: "Naver博客",
      map: "Naver地图",
      exploreServices: "查看业务领域",
      backHome: "返回首页",
    },
    headings: {
      home: "企业行政·公共采购·出入境签证",
      about: "JIHYE行政士事务所介绍",
      services: "业务领域",
      process: "办理流程",
      insights: "行政实务指南",
      consultation: "申请咨询",
      location: "来访路线",
      privacy: "个人信息处理方针",
      marketingWithdraw: "撤回营销信息接收同意",
      notFound: "找不到页面",
    },
    metaDescriptions: {
      home: "提供企业行政、公共采购和出入境签证业务指南。",
      about: "介绍姜智慧行政士及JIHYE行政士事务所的业务领域。",
      services: "查看六大类行政业务及具体服务。",
      process: "了解从初步咨询到业务办理的基本流程。",
      insights: "查看企业行政、采购和出入境实务指南。",
      consultation: "提交审核咨询所需的基本信息。",
      location: "查看文井站附近事务所的地址和联系方式。",
      privacy: "查看咨询表单当前使用的个人信息同意文件。",
      marketingWithdraw: "了解撤回营销信息接收同意的方法。",
      notFound: "无法找到您请求的页面。",
    },
    home: {
      pillars: [
        { title: "企业行政", summary: "企业认证、许可及法人或团体设立。" },
        { title: "公共采购", summary: "采购市场准入及产品、企业认证。" },
        { title: "出入境签证", summary: "就业、投资、家庭及停留业务。" },
      ],
    },
    forms: {
      consultation: {
        labels: {
          consent: "同意事项",
          website: "网站（请留空）",
          locale: "咨询语言",
          category: "咨询领域",
          categoryPlaceholder: "请选择领域",
          name: "姓名",
          phone: "电话号码",
          email: "电子邮箱",
          company: "公司或机构名称",
          preferredContact: "首选联系方式",
          message: "咨询内容",
          privacyConsent: "同意收集和使用个人信息",
          marketingConsent: "同意接收营销信息",
        },
        help: {
          category: "请选择最符合您需求的业务领域。",
          phone: "请输入可联系的电话号码。",
          email: "选择电子邮件联系或营销信息时必填。",
          company: "仅在适用时填写。",
          preferredContact: "请选择电话或电子邮件。",
          message: "请用至少20个字符说明相关事实和所需帮助。",
          privacyConsent: "提交咨询申请的必选项目。",
          marketingConsent: "可选项目，默认未勾选。",
          sensitiveIdWarning: "请勿填写居民登记号、护照号、外国人登记号等敏感识别信息。",
          noAttachments: "此阶段不接收附件。",
          noJavaScript: "安全在线提交需要JavaScript。如无法使用，请通过电话或电子邮件联系。",
          consentVersion: "文件版本",
          consentEffectiveAt: "生效日期",
          consentRetention: "保存期限",
          consentMonths: "个月",
        },
        errors: {
          required: "请填写必填项目。",
          invalidPhone: "请输入有效的电话号码。",
          invalidEmail: "请输入有效的电子邮箱地址。",
          messageLength: "咨询内容应为20至2,000个字符。",
          privacyRequired: "必须同意个人信息处理后才能提交。",
        },
        status: {
          submitting: "正在提交咨询申请…",
          success: "咨询申请已接收。请保留您的受理编号 {receiptId}。我们将在1至2个工作日内通过您选择的方式与您联系。",
          failure: "暂时无法提交咨询申请，请稍后重试。",
          configurationFailure: "无法载入当前同意文件，请稍后重试。",
          consentReady: "当前同意文件已载入，请查看内容后再表示同意。",
          consentUpdated: "同意文件已更新。请查看最新内容并重新同意。",
          consentLoading: "正在加载同意文件，请稍候。",
          sessionRefreshed: "页面打开时间较长，表单已重新准备。请确认内容后重新提交。",
          invalid: "请检查输入内容后重试。",
        },
        submit: "提交咨询申请",
        retryConsent: "重新加载同意文件",
      },
    },
    footer: {
      office: "JIHYE行政士事务所",
      representative: "代表行政士 姜智慧",
      contact: "联系方式",
      privacy: "个人信息处理方针",
      marketingWithdraw: "撤回营销同意",
      policies: "运营说明",
      rights: "保留所有权利。",
    },
    office: {
      name: "JIHYE行政士事务所",
      englishName: OFFICE.englishName,
      representative: "姜智慧 行政士",
      phone: OFFICE.phone,
      fax: OFFICE.fax,
      email: OFFICE.email,
      address: "首尔特别市松坡区法院路92号212室（文井洞，Partners 1）",
      nearby: "文井站附近",
      addressLabel: "地址",
      phoneLabel: "电话",
      faxLabel: "传真",
      emailLabel: "电子邮箱",
    },
    policies: {
      privacyHeading: "个人信息处理方针",
      marketingWithdrawHeading: "撤回营销信息接收同意",
    },
    serviceCatalog: {
      procurement: {
        title: "公共采购",
        summary: "协助办理进入公共采购市场所需的生产、产品确认和登记。",
        items: ["直接生产确认书", "工厂登记", "多数供应商合同（MAS）", "创新产品", "优秀采购产品"],
      },
      credibility: {
        title: "企业公信力认证",
        summary: "协助办理体现质量、公共价值和雇佣实践的认证。",
        items: [
          "家庭友好认证",
          "G-PASS企业指定",
          "GS认证",
          "KS或团体标准认证",
          "性能认证",
          "女性企业确认",
          "残疾人标准事业场所认证",
          "社会合作社",
          "工作与生活平衡优秀企业",
        ],
      },
      "safety-esg": {
        title: "安全与ESG",
        summary: "协助准备安全、社会责任和可持续经营相关事项。",
        items: ["SH评估", "SA评估", "ESG评估", "编制职业安全健康计划"],
      },
      "business-certification": {
        title: "企业认证",
        summary: "根据企业目标协助办理企业及研发认证。",
        items: [
          "Venture企业确认",
          "Innobiz认证",
          "Mainbiz认证",
          "企业附属研究所或研发专门部门",
          "ISO认证",
          "兵役指定企业",
        ],
      },
      "licensing-entity": {
        title: "许可与法人团体",
        summary: "协助办理经营许可及非营利法人、团体设立程序。",
        items: [
          "终身教育设施",
          "旅行业登记",
          "非营利社团法人或财团法人",
          "公益法人指定",
          "民间资格登记",
          "化妆品制造业登记",
          "化妆品责任销售业登记",
        ],
      },
      "immigration-visa": {
        title: "出入境与签证",
        summary: "协助办理就业、投资、家庭、演出、国籍和停留业务。",
        items: [
          "E-7签证",
          "E-6签证",
          "F-4、F-1、F-2、F-5或F-6签证",
          "C-3签证",
          "C-4签证",
          "D-10签证",
          "D-7签证",
          "D-8签证",
          "演出签证",
          "恢复国籍",
          "永久居留",
          "延长停留期限",
        ],
      },
    },
  },
  "zh-Hant": {
    navigation: {
      home: "首頁",
      about: "事務所介紹",
      services: "業務領域",
      process: "辦理流程",
      insights: "實務指南",
      consultation: "申請諮詢",
      location: "來訪路線",
    },
    accessibility: {
      skipToContent: "跳至主要內容",
      primaryNavigation: "主要導覽",
      mobileNavigation: "行動版導覽",
      openMenu: "開啟選單",
      languageSelection: "選擇語言",
      additionalContactOptions: "其他聯絡方式",
    },
    buttons: {
      consultation: "申請諮詢",
      phone: "電話聯絡",
      kakao: "KakaoTalk諮詢",
      blog: "Naver部落格",
      map: "Naver地圖",
      exploreServices: "查看業務領域",
      backHome: "返回首頁",
    },
    headings: {
      home: "企業行政·公共採購·出入境簽證",
      about: "JIHYE行政士事務所介紹",
      services: "業務領域",
      process: "辦理流程",
      insights: "行政實務指南",
      consultation: "申請諮詢",
      location: "來訪路線",
      privacy: "個人資料處理方針",
      marketingWithdraw: "撤回行銷資訊接收同意",
      notFound: "找不到頁面",
    },
    metaDescriptions: {
      home: "提供企業行政、公共採購及出入境簽證業務指南。",
      about: "介紹姜智慧行政士及JIHYE行政士事務所的業務領域。",
      services: "查看六大類行政業務及具體服務。",
      process: "瞭解從初步諮詢到業務辦理的基本流程。",
      insights: "查看企業行政、採購及出入境實務指南。",
      consultation: "提交審核諮詢所需的基本資料。",
      location: "查看文井站附近事務所的地址及聯絡方式。",
      privacy: "查看諮詢表單目前使用的個人資訊同意文件。",
      marketingWithdraw: "瞭解撤回行銷資訊接收同意的方法。",
      notFound: "無法找到您要求的頁面。",
    },
    home: {
      pillars: [
        { title: "企業行政", summary: "企業認證、許可及法人或團體設立。" },
        { title: "公共採購", summary: "採購市場准入及產品、企業認證。" },
        { title: "出入境簽證", summary: "就業、投資、家庭及停留業務。" },
      ],
    },
    forms: {
      consultation: {
        labels: {
          consent: "同意事項",
          website: "網站（請留空）",
          locale: "諮詢語言",
          category: "諮詢領域",
          categoryPlaceholder: "請選擇領域",
          name: "姓名",
          phone: "電話號碼",
          email: "電子郵件",
          company: "公司或機構名稱",
          preferredContact: "首選聯絡方式",
          message: "諮詢內容",
          privacyConsent: "同意蒐集及使用個人資料",
          marketingConsent: "同意接收行銷資訊",
        },
        help: {
          category: "請選擇最符合您需求的業務領域。",
          phone: "請輸入可聯絡的電話號碼。",
          email: "選擇電子郵件聯絡或行銷資訊時必填。",
          company: "僅在適用時填寫。",
          preferredContact: "請選擇電話或電子郵件。",
          message: "請用至少20個字元說明相關事實及所需協助。",
          privacyConsent: "提交諮詢申請的必選項目。",
          marketingConsent: "可選項目，預設未勾選。",
          sensitiveIdWarning: "請勿填寫居民登記號、護照號、外國人登記號等敏感識別資料。",
          noAttachments: "此階段不接收附件。",
          noJavaScript: "安全線上提交需要JavaScript。如無法使用，請透過電話或電子郵件聯絡。",
          consentVersion: "文件版本",
          consentEffectiveAt: "生效日期",
          consentRetention: "保存期限",
          consentMonths: "個月",
        },
        errors: {
          required: "請填寫必填項目。",
          invalidPhone: "請輸入有效的電話號碼。",
          invalidEmail: "請輸入有效的電子郵件地址。",
          messageLength: "諮詢內容應為20至2,000個字元。",
          privacyRequired: "必須同意個人資料處理後才能提交。",
        },
        status: {
          submitting: "正在提交諮詢申請…",
          success: "諮詢申請已接收。請保留您的受理編號 {receiptId}。我們將在1至2個工作日內透過您選擇的方式與您聯繫。",
          failure: "暫時無法提交諮詢申請，請稍後重試。",
          configurationFailure: "無法載入目前同意文件，請稍後重試。",
          consentReady: "目前同意文件已載入，請查看內容後再表示同意。",
          consentUpdated: "同意文件已更新。請查看最新內容並重新同意。",
          consentLoading: "正在載入同意文件，請稍候。",
          sessionRefreshed: "頁面開啟時間較長，表單已重新準備。請確認內容後重新提交。",
          invalid: "請檢查輸入內容後重試。",
        },
        submit: "提交諮詢申請",
        retryConsent: "重新載入同意文件",
      },
    },
    footer: {
      office: "JIHYE行政士事務所",
      representative: "代表行政士 姜智慧",
      contact: "聯絡方式",
      privacy: "個人資料處理方針",
      marketingWithdraw: "撤回行銷同意",
      policies: "營運說明",
      rights: "保留所有權利。",
    },
    office: {
      name: "JIHYE行政士事務所",
      englishName: OFFICE.englishName,
      representative: "姜智慧 行政士",
      phone: OFFICE.phone,
      fax: OFFICE.fax,
      email: OFFICE.email,
      address: "首爾特別市松坡區法院路92號212室（文井洞，Partners 1）",
      nearby: "文井站附近",
      addressLabel: "地址",
      phoneLabel: "電話",
      faxLabel: "傳真",
      emailLabel: "電子郵件",
    },
    policies: {
      privacyHeading: "個人資料處理方針",
      marketingWithdrawHeading: "撤回行銷資訊接收同意",
    },
    serviceCatalog: {
      procurement: {
        title: "公共採購",
        summary: "協助辦理進入公共採購市場所需的生產、產品確認及登記。",
        items: ["直接生產確認書", "工廠登記", "多數供應商合約（MAS）", "創新產品", "優秀採購產品"],
      },
      credibility: {
        title: "企業公信力認證",
        summary: "協助辦理體現品質、公共價值及僱用實務的認證。",
        items: [
          "家庭友善認證",
          "G-PASS企業指定",
          "GS認證",
          "KS或團體標準認證",
          "性能認證",
          "女性企業確認",
          "身心障礙者標準事業場所認證",
          "社會合作社",
          "工作與生活平衡優秀企業",
        ],
      },
      "safety-esg": {
        title: "安全與ESG",
        summary: "協助準備安全、社會責任及永續經營相關事項。",
        items: ["SH評估", "SA評估", "ESG評估", "編製職業安全衛生計畫"],
      },
      "business-certification": {
        title: "企業認證",
        summary: "根據企業目標協助辦理企業及研發認證。",
        items: [
          "Venture企業確認",
          "Innobiz認證",
          "Mainbiz認證",
          "企業附屬研究所或研發專門部門",
          "ISO認證",
          "兵役指定企業",
        ],
      },
      "licensing-entity": {
        title: "許可與法人團體",
        summary: "協助辦理經營許可及非營利法人、團體設立程序。",
        items: [
          "終身教育設施",
          "旅行業登記",
          "非營利社團法人或財團法人",
          "公益法人指定",
          "民間資格登記",
          "化妝品製造業登記",
          "化妝品責任銷售業登記",
        ],
      },
      "immigration-visa": {
        title: "出入境與簽證",
        summary: "協助辦理就業、投資、家庭、演出、國籍及停留業務。",
        items: [
          "E-7簽證",
          "E-6簽證",
          "F-4、F-1、F-2、F-5或F-6簽證",
          "C-3簽證",
          "C-4簽證",
          "D-10簽證",
          "D-7簽證",
          "D-8簽證",
          "演出簽證",
          "恢復國籍",
          "永久居留",
          "延長停留期限",
        ],
      },
    },
  },
} satisfies Record<Locale, LocaleText>;

const pageNarrative = {
  ko: {
    home: {
      eyebrow: "기업과 사람의 행정 절차를 함께 설계합니다",
      intro: "기업행정, 공공조달, 출입국·비자 세 분야를 같은 비중으로 검토하고 필요한 절차를 분명하게 안내합니다.",
      navigatorTitle: "필요한 업무에서 시작하세요",
      navigatorBody: "현재 상황과 목표에 가까운 분야를 선택하면 세부 업무와 준비 방향을 확인할 수 있습니다.",
      principlesTitle: "명확한 범위, 확인 가능한 절차",
      principles: [
        { title: "직접 확인", body: "의뢰 목적과 현재 자료를 먼저 확인합니다." },
        { title: "대안 검토", body: "가능한 절차와 선행 조건을 구분해 설명합니다." },
        { title: "현장 중심", body: "실제 접수와 보완 단계에 필요한 준비를 정리합니다." },
      ],
      insightsTitle: "분야별 실무 안내",
      insights: [
        { title: "조달시장 진입 준비", body: "제품·생산·기업 요건을 나누어 확인합니다." },
        { title: "기업 인증 준비", body: "신청 목적과 유지 요건을 함께 살핍니다." },
        { title: "체류 자격 검토", body: "활동 목적과 현재 체류 상태부터 확인합니다." },
      ],
      credentialsTitle: "대표 행정사 소개",
      credentialsBody: "공개가 승인된 학력, 경력, 자격 정보만 안내합니다.",
      consultationTitle: "상담 요청을 남겨 주세요",
      consultationBody: "민감한 식별정보와 첨부파일 없이 검토에 필요한 기본 사실만 보내 주세요.",
      portraitLabel: "브론즈, 샌드, 아이보리 색상의 기하학 브랜드 일러스트",
      sectionLabels: { navigator: "업무 찾기", principles: "업무 원칙", profile: "대표 행정사" },
      insightCategories: ["공공조달", "기업행정", "출입국·비자"],
    },
    about: {
      intro: "지혜행정사사무소는 공개가 승인된 대표자의 교육, 경력, 자격 정보를 바탕으로 업무 범위를 안내합니다.",
      educationHeading: "학력",
      careerHeading: "경력",
      qualificationsHeading: "자격",
      disclosure: "기관명이 OO로 마스킹된 자료는 비공개 요약으로만 표시하며 임의로 복원하지 않습니다.",
    },
    profile: {
      education: REPRESENTATIVE.education,
      career: REPRESENTATIVE.career,
      qualifications: REPRESENTATIVE.qualifications,
    },
    servicesIntro: "여섯 업무군의 세부 항목을 확인하고 현재 상황에 맞는 상담 분야를 선택해 주세요.",
    process: {
      intro: "상담 요청부터 업무 진행까지의 기본 흐름입니다. 구체적인 범위와 일정은 사실관계 확인 후 정합니다.",
      steps: [
        { title: "01 상담 요청", body: "연락처와 검토가 필요한 기본 사실을 전달합니다." },
        { title: "02 범위 확인", body: "목표, 현재 상태, 필요한 자료와 선행 조건을 확인합니다." },
        { title: "03 위임 협의", body: "업무 범위와 역할을 확인한 뒤 위임 여부를 결정합니다." },
        { title: "04 진행 안내", body: "접수, 보완, 결과 확인의 상태를 단계별로 안내합니다." },
      ],
    },
    insights: {
      intro: "공개 전 검토가 완료된 실무 안내만 게시할 예정입니다.",
      note: "현재는 서비스 범위 안내 페이지이며, 사례 수·성공률·순위와 같은 검증되지 않은 표현을 사용하지 않습니다.",
    },
    consultationIntro: "상담 검토에 필요한 기본 정보를 입력해 주세요. 입력하신 내용은 사무소로 안전하게 접수되며, 담당자가 확인 후 선택하신 방법으로 연락드립니다.",
    locationIntro: "문정역 인근 사무소의 주소와 연락처입니다. 방문 전 연락해 주세요.",
    privacy: {
      intro: "아래 문서는 관리자가 활성화했으며 현재 상담 접수에서 사용하는 개인정보 동의 문서입니다.",
      support: "문서 내용에 관한 문의는 사무소로 연락해 주세요.",
    },
    marketingWithdraw: {
      intro: "마케팅 동의 확인 이메일에 포함된 일회용 철회 링크로 수신 동의를 철회할 수 있습니다.",
      steps: ["마케팅 정보 수신에 동의했을 때 발송된 확인 이메일을 엽니다.", "이메일의 일회용 철회 링크를 열고 내용을 확인합니다.", "철회를 제출한 뒤 한국어 확인 화면에서 처리 결과를 확인합니다."],
      support: "링크를 찾거나 사용하는 데 도움이 필요하면 사무소로 문의해 주세요. 전화와 이메일은 지원 연락 수단이며 그 자체로 동의를 철회하지 않습니다.",
    },
    notFoundBody: "주소를 다시 확인하거나 아래 링크로 홈 화면으로 이동해 주세요.",
    formOptions: { phone: "전화", email: "이메일", other: "기타" },
  },
  en: {
    home: {
      eyebrow: "Administrative pathways for organizations and people",
      intro: "We give equal attention to business administration, public procurement, and immigration or visa matters, with a clear view of the next procedure.",
      navigatorTitle: "Start with the work you need",
      navigatorBody: "Choose the area closest to your current situation to review its services and preparation path.",
      principlesTitle: "Clear scope, verifiable process",
      principles: [
        { title: "Direct review", body: "We begin with your objective and the material currently available." },
        { title: "Practical alternatives", body: "Available procedures and prerequisites are explained separately." },
        { title: "Procedure focused", body: "Preparation is organized around filing and follow-up stages." },
      ],
      insightsTitle: "Practice-area guidance",
      insights: [
        { title: "Entering procurement", body: "Review product, production, and business requirements separately." },
        { title: "Preparing certification", body: "Consider both the application purpose and ongoing requirements." },
        { title: "Reviewing stay status", body: "Begin with the intended activity and current immigration status." },
      ],
      credentialsTitle: "Representative profile",
      credentialsBody: "Only approved education, career, and qualification facts are shown.",
      consultationTitle: "Tell us what you need reviewed",
      consultationBody: "Send only the basic facts needed for review, without sensitive identifiers or attachments.",
      portraitLabel: "Bronze, sand, and ivory geometric brand illustration",
      sectionLabels: { navigator: "Service navigator", principles: "Working principles", profile: "Representative profile" },
      insightCategories: ["Public procurement", "Business administration", "Immigration and visas"],
    },
    about: {
      intro: "JIHYE Administrative Attorney presents its scope using only approved education, career, and qualification details.",
      educationHeading: "Education",
      careerHeading: "Career",
      qualificationsHeading: "Qualifications",
      disclosure: "Institutions masked as OO remain non-public summaries and are never inferred or resolved.",
    },
    profile: {
      education: [
        "Hanyang University, Bachelor's and Master's in Business Administration",
        "Ajou University Graduate School, Master's in Education and Counseling",
        "Namseoul University, Master's Program in AI Public Procurement",
      ],
      career: ["Director, Public Procurement Research Institute"],
      qualifications: ["11th Administrative Attorney", "ISO 45001 Auditor"],
    },
    servicesIntro: "Review the detailed work in each of the six service groups and choose the closest consultation category.",
    process: {
      intro: "This is the basic path from an initial request to active work. Scope and timing are agreed after the facts are reviewed.",
      steps: [
        { title: "01 Request", body: "Provide contact details and the basic facts that need review." },
        { title: "02 Scope review", body: "Confirm the objective, current status, materials, and prerequisites." },
        { title: "03 Engagement", body: "Agree the work scope and responsibilities before engagement." },
        { title: "04 Progress", body: "Receive updates for filing, follow-up requests, and results." },
      ],
    },
    insights: {
      intro: "Only practical guidance that has completed review will be published here.",
      note: "This is currently a service-scope page. It does not make unverified claims about cases, success rates, rankings, or reviews.",
    },
    consultationIntro: "Please share the basic information we need to review your case. Your details are sent securely to the office, and a staff member will contact you through your preferred method after reviewing them.",
    locationIntro: "Office address and contact details near Munjeong Station. Please contact the office before visiting.",
    privacy: {
      intro: "This administrator-activated privacy consent document is the version currently used for consultation intake.",
      support: "Contact the office if you need help understanding this document.",
    },
    marketingWithdraw: {
      intro: "Use the one-time withdrawal link sent in the marketing consent confirmation email.",
      steps: ["Open the confirmation email sent when marketing consent was accepted.", "Open the one-time withdrawal link and review the confirmation.", "Submit the withdrawal and review the result on the localized confirmation page."],
      support: "If you need help finding or using the link, contact the office. Phone and email are support channels; they do not withdraw consent by themselves.",
    },
    notFoundBody: "Check the address or use the link below to return home.",
    formOptions: { phone: "Phone", email: "Email", other: "Other" },
  },
  "zh-Hans": {
    home: {
      eyebrow: "为企业与个人梳理行政程序",
      intro: "同等重视企业行政、公共采购与出入境签证事项，并清楚说明下一步程序。",
      navigatorTitle: "从您需要的业务开始",
      navigatorBody: "选择最接近现状的领域，查看具体服务与准备方向。",
      principlesTitle: "明确范围，可核实程序",
      principles: [
        { title: "直接确认", body: "先确认委托目的与现有资料。" },
        { title: "替代方案", body: "分别说明可行程序与前置条件。" },
        { title: "程序导向", body: "围绕申请与补充阶段整理准备事项。" },
      ],
      insightsTitle: "业务领域指南",
      insights: [
        { title: "进入采购市场", body: "分别核对产品、生产与企业条件。" },
        { title: "准备企业认证", body: "同时考虑申请目的与持续条件。" },
        { title: "审查居留资格", body: "从活动目的与当前居留状态开始。" },
      ],
      credentialsTitle: "代表行政士简介",
      credentialsBody: "仅公开已获批准的教育、经历与资格信息。",
      consultationTitle: "请留下咨询需求",
      consultationBody: "请勿提交敏感身份信息或附件，仅发送审查所需基本事实。",
      portraitLabel: "青铜色、沙色与象牙色的几何品牌插图",
      sectionLabels: { navigator: "业务导航", principles: "办理原则", profile: "代表行政士简介" },
      insightCategories: ["公共采购", "企业行政", "出入境签证"],
    },
    about: {
      intro: "JIHYE行政士事务所仅依据获准公开的教育、经历与资格信息介绍业务范围。",
      educationHeading: "教育",
      careerHeading: "经历",
      qualificationsHeading: "资格",
      disclosure: "以OO遮蔽的机构仅作为非公开摘要，不作推断或还原。",
    },
    profile: {
      education: ["汉阳大学经营学学士、硕士", "亚洲大学研究生院教育学与咨询硕士", "南首尔大学AI公共采购学硕士课程"],
      career: ["公共采购研究所理事"],
      qualifications: ["第11届行政士", "ISO 45001审核员"],
    },
    servicesIntro: "查看六个业务组的详细项目，并选择最接近的咨询类别。",
    process: {
      intro: "这是从咨询请求到业务进行的基本流程，具体范围与时间在确认事实后商定。",
      steps: [
        { title: "01 提交请求", body: "提供联系方式与需要审查的基本事实。" },
        { title: "02 确认范围", body: "确认目标、现状、资料与前置条件。" },
        { title: "03 委托协商", body: "确认工作范围与责任后决定是否委托。" },
        { title: "04 进度说明", body: "按申请、补充与结果阶段说明状态。" },
      ],
    },
    insights: { intro: "仅发布完成审查的实务指南。", note: "当前为服务范围说明页，不使用未经核实的案例数、成功率、排名或评价。" },
    consultationIntro: "请填写咨询审核所需的基本信息。您填写的内容将安全送达本事务所，专员确认后会通过您选择的方式与您联系。",
    locationIntro: "文井站附近事务所的地址与联系方式，来访前请先联系。",
    privacy: {
      intro: "下方显示管理员已启用且咨询表单正在使用的当前个人信息同意文件。",
      support: "如对文件内容有疑问，请联系事务所。",
    },
    marketingWithdraw: {
      intro: "请使用营销同意确认邮件中的一次性撤回链接。",
      steps: ["打开接受营销信息时发送的确认邮件。", "打开邮件中的一次性撤回链接并确认内容。", "提交撤回后，在本地化确认页面查看处理结果。"],
      support: "如需查找或使用链接方面的帮助，请联系事务所。电话和电子邮件仅用于支持，本身不会撤回同意。",
    },
    notFoundBody: "请检查地址，或使用下方链接返回首页。",
    formOptions: { phone: "电话", email: "电子邮件", other: "其他" },
  },
  "zh-Hant": {
    home: {
      eyebrow: "為企業與個人梳理行政程序",
      intro: "同等重視企業行政、公共採購與出入境簽證事項，並清楚說明下一步程序。",
      navigatorTitle: "從您需要的業務開始",
      navigatorBody: "選擇最接近現況的領域，查看具體服務與準備方向。",
      principlesTitle: "明確範圍，可核實程序",
      principles: [
        { title: "直接確認", body: "先確認委託目的與現有資料。" },
        { title: "替代方案", body: "分別說明可行程序與前置條件。" },
        { title: "程序導向", body: "圍繞申請與補充階段整理準備事項。" },
      ],
      insightsTitle: "業務領域指南",
      insights: [
        { title: "進入採購市場", body: "分別核對產品、生產與企業條件。" },
        { title: "準備企業認證", body: "同時考慮申請目的與持續條件。" },
        { title: "審查居留資格", body: "從活動目的與目前居留狀態開始。" },
      ],
      credentialsTitle: "代表行政士簡介",
      credentialsBody: "僅公開已獲批准的教育、經歷與資格資訊。",
      consultationTitle: "請留下諮詢需求",
      consultationBody: "請勿提交敏感身分資訊或附件，僅傳送審查所需基本事實。",
      portraitLabel: "青銅色、沙色與象牙色的幾何品牌插圖",
      sectionLabels: { navigator: "業務導覽", principles: "辦理原則", profile: "代表行政士簡介" },
      insightCategories: ["公共採購", "企業行政", "出入境簽證"],
    },
    about: {
      intro: "JIHYE行政士事務所僅依據獲准公開的教育、經歷與資格資訊介紹業務範圍。",
      educationHeading: "教育",
      careerHeading: "經歷",
      qualificationsHeading: "資格",
      disclosure: "以OO遮蔽的機構僅作為非公開摘要，不作推斷或還原。",
    },
    profile: {
      education: ["漢陽大學經營學學士、碩士", "亞洲大學研究所教育學與諮商碩士", "南首爾大學AI公共採購學碩士課程"],
      career: ["公共採購研究所理事"],
      qualifications: ["第11屆行政士", "ISO 45001稽核員"],
    },
    servicesIntro: "查看六個業務組的詳細項目，並選擇最接近的諮詢類別。",
    process: {
      intro: "這是從諮詢請求到業務進行的基本流程，具體範圍與時間在確認事實後商定。",
      steps: [
        { title: "01 提交請求", body: "提供聯絡方式與需要審查的基本事實。" },
        { title: "02 確認範圍", body: "確認目標、現況、資料與前置條件。" },
        { title: "03 委託協商", body: "確認工作範圍與責任後決定是否委託。" },
        { title: "04 進度說明", body: "按申請、補充與結果階段說明狀態。" },
      ],
    },
    insights: { intro: "僅發布完成審查的實務指南。", note: "目前為服務範圍說明頁，不使用未經核實的案例數、成功率、排名或評價。" },
    consultationIntro: "請填寫諮詢審核所需的基本資訊。您填寫的內容將安全送達本事務所，專員確認後會透過您選擇的方式與您聯繫。",
    locationIntro: "文井站附近事務所的地址與聯絡方式，來訪前請先聯絡。",
    privacy: {
      intro: "下方顯示管理員已啟用且諮詢表單目前使用的個人資訊同意文件。",
      support: "如對文件內容有疑問，請聯絡事務所。",
    },
    marketingWithdraw: {
      intro: "請使用行銷同意確認郵件中的一次性撤回連結。",
      steps: ["開啟接受行銷資訊時寄送的確認郵件。", "開啟郵件中的一次性撤回連結並確認內容。", "提交撤回後，在本地化確認頁面查看處理結果。"],
      support: "如需尋找或使用連結方面的協助，請聯絡事務所。電話與電子郵件僅供支援，本身不會撤回同意。",
    },
    notFoundBody: "請檢查地址，或使用下方連結返回首頁。",
    formOptions: { phone: "電話", email: "電子郵件", other: "其他" },
  },
} satisfies Record<Locale, LocalePageNarrative>;

function buildLocaleContent(locale: Locale, text: LocaleText): LocaleSiteContent {
  const meta = Object.fromEntries(
    PAGE_KEYS.map((key) => [
      key,
      {
        title: `${text.headings[key]} | ${text.office.name}`,
        description: text.metaDescriptions[key],
      },
    ]),
  ) as Record<PageKey, { title: string; description: string }>;

  return {
    navigation: text.navigation,
    accessibility: text.accessibility,
    buttons: text.buttons,
    headings: text.headings,
    meta,
    home: text.home,
    pages: pageNarrative[locale],
    forms: text.forms,
    footer: text.footer,
    office: text.office,
    policies: text.policies,
    services: {
      categories: SERVICE_CATEGORY_SLUGS.map((slug) => ({
        slug,
        ...text.serviceCatalog[slug],
      })),
    },
  };
}

export const siteContent = {
  ko: buildLocaleContent("ko", localizedText.ko),
  en: buildLocaleContent("en", localizedText.en),
  "zh-Hans": buildLocaleContent("zh-Hans", localizedText["zh-Hans"]),
  "zh-Hant": buildLocaleContent("zh-Hant", localizedText["zh-Hant"]),
} satisfies Record<Locale, LocaleSiteContent>;

export type SiteContent = typeof siteContent;

function assertMatchesRequiredShape(value: unknown, template: unknown, path: string): void {
  if (typeof template === "string") {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Missing translation: ${path}`);
    }
    return;
  }

  if (Array.isArray(template)) {
    if (!Array.isArray(value)) throw new Error(`Missing translation: ${path}`);
    template.forEach((item, index) => {
      assertMatchesRequiredShape(value[index], item, `${path}.${index}`);
    });
    return;
  }

  if (template !== null && typeof template === "object") {
    if (value === null || typeof value !== "object") {
      throw new Error(`Missing translation: ${path}`);
    }

    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(template)) {
      assertMatchesRequiredShape(record[key], child, `${path}.${key}`);
    }
  }
}

export function validateSiteContent(content: unknown): asserts content is SiteContent {
  if (content === null || typeof content !== "object") {
    throw new Error("Missing site content");
  }

  const record = content as Record<string, unknown>;
  for (const locale of LOCALES) {
    if (!(locale in record)) throw new Error(`Missing locale: ${locale}`);
    assertMatchesRequiredShape(record[locale], siteContent.ko, locale);
  }
}

validateSiteContent(siteContent);
