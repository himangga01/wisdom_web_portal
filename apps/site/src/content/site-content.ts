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
        locale: string;
        category: string;
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
      };
      errors: {
        required: string;
        invalidPhone: string;
        invalidEmail: string;
        messageLength: string;
        privacyRequired: string;
      };
      submit: string;
    };
  };
  footer: {
    office: string;
    representative: string;
    contact: string;
    privacy: string;
    marketingWithdraw: string;
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
  };
  policies: {
    privacyHeading: string;
    marketingWithdrawHeading: string;
    draftNotice: string;
    launchGate: string;
  };
  serviceCatalog: Record<ServiceCategorySlug, ServiceCategoryTranslation>;
}

interface LocaleSiteContent extends Omit<LocaleText, "metaDescriptions" | "serviceCatalog"> {
  meta: Record<PageKey, { title: string; description: string }>;
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
      privacy: "개인정보 처리방침 운영 초안을 확인합니다.",
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
          locale: "상담 언어",
          category: "상담 분야",
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
        },
        errors: {
          required: "필수 항목을 입력해 주세요.",
          invalidPhone: "올바른 전화번호를 입력해 주세요.",
          invalidEmail: "올바른 이메일 주소를 입력해 주세요.",
          messageLength: "상담 내용은 20자 이상 2,000자 이하로 입력해 주세요.",
          privacyRequired: "개인정보 수집·이용에 동의해야 상담을 접수할 수 있습니다.",
        },
        submit: "상담 요청 보내기",
      },
    },
    footer: {
      office: "지혜행정사사무소",
      representative: "대표 강지혜 행정사",
      contact: "연락처",
      privacy: "개인정보 처리방침",
      marketingWithdraw: "마케팅 수신 동의 철회",
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
    },
    policies: {
      privacyHeading: "개인정보 처리방침",
      marketingWithdrawHeading: "마케팅 수신 동의 철회",
      draftNotice: "운영 초안 — 법률 검토 완료 전 공개하거나 사용하지 않습니다.",
      launchGate: "법률 검토 전 운영 금지",
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
        items: ["SH 인증", "SA 인증", "ESG", "산업안전보건계획서"],
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
      privacy: "Review the draft operational privacy policy.",
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
          locale: "Consultation language",
          category: "Service category",
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
        },
        errors: {
          required: "Complete this required field.",
          invalidPhone: "Enter a valid phone number.",
          invalidEmail: "Enter a valid email address.",
          messageLength: "Enter between 20 and 2,000 characters.",
          privacyRequired: "Privacy consent is required to submit the request.",
        },
        submit: "Send consultation request",
      },
    },
    footer: {
      office: "JIHYE Administrative Attorney",
      representative: "Administrative Attorney Jihye Kang",
      contact: "Contact",
      privacy: "Privacy Policy",
      marketingWithdraw: "Withdraw Marketing Consent",
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
    },
    policies: {
      privacyHeading: "Privacy Policy",
      marketingWithdrawHeading: "Withdraw Marketing Consent",
      draftNotice: "Operational draft — do not publish or use before legal review is complete.",
      launchGate: "법률 검토 전 운영 금지",
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
        items: ["SH certification", "SA certification", "ESG", "Occupational safety and health plan"],
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
      privacy: "查看个人信息处理方针运营草案。",
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
          locale: "咨询语言",
          category: "咨询领域",
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
        },
        errors: {
          required: "请填写必填项目。",
          invalidPhone: "请输入有效的电话号码。",
          invalidEmail: "请输入有效的电子邮箱地址。",
          messageLength: "咨询内容应为20至2,000个字符。",
          privacyRequired: "必须同意个人信息处理后才能提交。",
        },
        submit: "提交咨询申请",
      },
    },
    footer: {
      office: "JIHYE行政士事务所",
      representative: "代表行政士 姜智慧",
      contact: "联系方式",
      privacy: "个人信息处理方针",
      marketingWithdraw: "撤回营销同意",
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
    },
    policies: {
      privacyHeading: "个人信息处理方针",
      marketingWithdrawHeading: "撤回营销信息接收同意",
      draftNotice: "运营草案——完成法律审查前不得公开或使用。",
      launchGate: "법률 검토 전 운영 금지",
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
        items: ["SH认证", "SA认证", "ESG", "职业安全健康计划"],
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
      privacy: "查看個人資料處理方針營運草案。",
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
          locale: "諮詢語言",
          category: "諮詢領域",
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
        },
        errors: {
          required: "請填寫必填項目。",
          invalidPhone: "請輸入有效的電話號碼。",
          invalidEmail: "請輸入有效的電子郵件地址。",
          messageLength: "諮詢內容應為20至2,000個字元。",
          privacyRequired: "必須同意個人資料處理後才能提交。",
        },
        submit: "提交諮詢申請",
      },
    },
    footer: {
      office: "JIHYE行政士事務所",
      representative: "代表行政士 姜智慧",
      contact: "聯絡方式",
      privacy: "個人資料處理方針",
      marketingWithdraw: "撤回行銷同意",
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
    },
    policies: {
      privacyHeading: "個人資料處理方針",
      marketingWithdrawHeading: "撤回行銷資訊接收同意",
      draftNotice: "營運草案——完成法律審查前不得公開或使用。",
      launchGate: "법률 검토 전 운영 금지",
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
        items: ["SH認證", "SA認證", "ESG", "職業安全健康計畫"],
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

function buildLocaleContent(text: LocaleText): LocaleSiteContent {
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
    buttons: text.buttons,
    headings: text.headings,
    meta,
    home: text.home,
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
  ko: buildLocaleContent(localizedText.ko),
  en: buildLocaleContent(localizedText.en),
  "zh-Hans": buildLocaleContent(localizedText["zh-Hans"]),
  "zh-Hant": buildLocaleContent(localizedText["zh-Hant"]),
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
