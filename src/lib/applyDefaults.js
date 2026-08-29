/* The volunteer and career forms a fresh database starts with.

   ⚠ SEED DATA, not a fallback. The site renders the ACTIVE form and nothing
   else, so these exist to be written into the database as real, editable,
   active forms — matching what the pages already said before the CMS owned
   them. Once seeded, editing this file does nothing; edit the form in the CMS.

   Written by scripts/seed-lib.js, and only when a kind has no forms at all, so
   re-seeding never disturbs what an editor has built. */

const identity = [
  { key: "name", type: "name", label: "Your name", required: true },
  { key: "email", type: "email", label: "Email", required: true },
  {
    key: "mobile",
    type: "phone",
    label: "Mobile",
    required: true,
    placeholder: "90000 00000",
  },
];

const FIELDS = {
  volunteer: [
    ...identity,
    {
      key: "programme",
      type: "checkboxes",
      label: "Which programmes interest you",
      help: "Tick as many as you like.",
      options: [
        { label: "Iwan Youth" },
        { label: "Iwan Kids" },
        { label: "Iwan Women" },
        { label: "Iwan Men" },
        { label: "Wherever I am needed" },
      ],
    },
    {
      key: "role",
      type: "checkboxes",
      label: "What would you enjoy helping with",
      options: [
        { label: "Teaching or mentoring" },
        { label: "Running events" },
        { label: "Food drives and relief work" },
        { label: "Photography, design or writing" },
        { label: "Admin and coordination" },
        { label: "Something else — I will say below" },
      ],
    },
    {
      key: "availability",
      type: "checkboxes",
      label: "When are you usually free",
      options: [
        { label: "Weekday mornings" },
        { label: "Weekday evenings" },
        { label: "Weekends" },
        { label: "One-off events only" },
      ],
    },
    {
      key: "experience",
      type: "radio",
      label: "Have you volunteered with Iwan before",
      options: [{ label: "Yes" }, { label: "No" }],
    },
    {
      key: "about",
      type: "textarea",
      label: "Tell us a little about yourself",
      help: "What you enjoy, what you are good at, anything you have done before. A few lines is plenty.",
      required: true,
    },
    {
      key: "consent",
      type: "consent",
      label: "I am happy for Iwan to contact me about volunteering",
    },
  ],

  career: [
    ...identity,
    {
      key: "role",
      type: "text",
      label: "What kind of role are you looking for",
      placeholder: "Programme coordinator, designer, fundraiser…",
      required: true,
    },
    { key: "city", type: "text", label: "Where are you based", placeholder: "Bangalore" },
    {
      key: "experience",
      type: "select",
      label: "Years of experience",
      options: [
        { label: "Less than a year" },
        { label: "1–3 years" },
        { label: "3–5 years" },
        { label: "5–10 years" },
        { label: "More than 10 years" },
      ],
    },
    {
      key: "availability",
      type: "radio",
      label: "When could you start",
      options: [
        { label: "Right away" },
        { label: "Within a month" },
        { label: "In one to three months" },
        { label: "Just exploring for now" },
      ],
    },
    {
      key: "portfolio",
      type: "text",
      label: "A link to your CV, portfolio or LinkedIn",
      /* ⚠ A link, not an upload — there is no file store behind this service. */
      help: "Anywhere we can read more. A shared Drive link is fine.",
      placeholder: "https://",
    },
    {
      key: "about",
      type: "textarea",
      label: "What would you like to work on",
      help: "What you have done, and what you are hoping to do next.",
      required: true,
    },
    {
      key: "consent",
      type: "consent",
      label: "I am happy for Iwan to keep my details on file",
    },
  ],
};

/* The whole form, copy included — what the pages read before the CMS owned
   them, so a seeded database looks exactly like the site already did. */
export const DEFAULT_APPLY_FORMS = {
  volunteer: {
    kind: "volunteer",
    name: "Default volunteer form",
    countries: [],
    eyebrow: "Volunteer",
    heading: "Give a few hours to",
    mark: "your community.",
    intro:
      "Every class, workshop and gathering happens because someone made time for it. Tell us what you enjoy and when you are free, and we will find where you fit.",
    formHeading: "Tell us about you",
    submitLabel: "Send my details",
    subscribeLabel: "Keep me posted about Iwan events and volunteering",
    doneHeading: "Thank you — we have your details",
    doneBody:
      "Someone from the team will be in touch when something matches what you are up for. That is usually within a week.",
    fields: FIELDS.volunteer,
  },

  career: {
    kind: "career",
    name: "Default career form",
    countries: [],
    eyebrow: "Work with us",
    heading: "Build something that",
    mark: "lasts.",
    /* ⚠ Says plainly that there is no jobs board. Iwan does not have one, and
       implying otherwise is the mistake that got the News section pulled. */
    intro:
      "We are a small team and we are always glad to hear from people who want to work with us. There is no jobs board — tell us what you do and what you are looking for, and we will be in touch when something fits.",
    formHeading: "Tell us about you",
    submitLabel: "Send my details",
    subscribeLabel: "Keep me posted about Iwan news and openings",
    doneHeading: "Thank you — we have your details",
    doneBody:
      "We read everything that comes in. If there is a fit now or later, someone will be in touch.",
    fields: FIELDS.career,
  },
};

export default DEFAULT_APPLY_FORMS;
