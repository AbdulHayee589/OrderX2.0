import { ProductIcon } from "@shopify/polaris-icons";
import { useState } from "react";
import OldProduct from "./OldProduct";
import NewProduct from "./NewProduct";
import axios from "axios";
export default function First({
  products = [],
  currentStep,
  setCurrentStep,
  totalSteps,
}) {
  const renderMedia = (imageUrl) => {
    return imageUrl ?? ProductIcon;
  };

  const renderAltText = (altText) => {
    return altText ?? "Product";
  };

  function truncateString(text, maxLength = 30) {
    if (!text) return "";
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + "…";
  }

  const [selected, setSelected] = useState(null);

  const tabs = ["Import new Products", "Old Products"];
  const [selectedTab, setSelectedTab] = useState("Import new Products");
  const [selectedService, setSelectedService] = useState("AliExpress");
  const [link, setLink] = useState("");

  const LANGUAGES = [
    "Afrikaans",
    "Albanian",
    "Amharic",
    "Arabic",
    "Armenian",
    "Assamese",
    "Azerbaijani",
    "Basque",
    "Bengali",
    "Bosnian",
    "Bulgarian",
    "Burmese",
    "Catalan",
    "Cebuano",
    "Chinese (Simplified)",
    "Chinese (Traditional)",
    "Corsican",
    "Croatian",
    "Czech",
    "Danish",
    "Dutch",
    "English",
    "Esperanto",
    "Estonian",
    "Finnish",
    "French",
    "Frisian",
    "Galician",
    "Georgian",
    "German",
    "Greek",
    "Gujarati",
    "Haitian Creole",
    "Hausa",
    "Hawaiian",
    "Hebrew",
    "Hindi",
    "Hmong",
    "Hungarian",
    "Icelandic",
    "Igbo",
    "Indonesian",
    "Irish",
    "Italian",
    "Japanese",
    "Javanese",
    "Kannada",
    "Kazakh",
    "Khmer",
    "Kinyarwanda",
    "Korean",
    "Kurdish",
    "Kyrgyz",
    "Lao",
    "Latin",
    "Latvian",
    "Lithuanian",
    "Luxembourgish",
    "Macedonian",
    "Malagasy",
    "Malay",
    "Malayalam",
    "Maltese",
    "Maori",
    "Marathi",
    "Mongolian",
    "Nepali",
    "Norwegian",
    "Nyanja (Chichewa)",
    "Odia (Oriya)",
    "Pashto",
    "Persian",
    "Polish",
    "Portuguese",
    "Punjabi",
    "Romanian",
    "Russian",
    "Samoan",
    "Scots Gaelic",
    "Serbian",
    "Sesotho",
    "Shona",
    "Sindhi",
    "Sinhala",
    "Slovak",
    "Slovenian",
    "Somali",
    "Spanish",
    "Sundanese",
    "Swahili",
    "Swedish",
    "Tagalog",
    "Tajik",
    "Tamil",
    "Tatar",
    "Telugu",
    "Thai",
    "Turkish",
    "Turkmen",
    "Ukrainian",
    "Urdu",
    "Uyghur",
    "Uzbek",
    "Vietnamese",
    "Welsh",
    "Xhosa",
    "Yiddish",
    "Yoruba",
    "Zulu",
  ];

  const [storeLanguage, setStoreLanguage] = useState("English");

  const isDisabled =
    (selectedTab === "Old Products" && selected === null) ||
    (selectedTab === "Import new Products" && !link);
  const [error, setError] = useState(false);
  const handleSubmit = async () => {
    setError(false);
    if (currentStep < totalSteps) {
      if (currentStep === 0) {
        if (isDisabled) {
          setError(true);
          shopify.toast.show("Please provide the required details");
        } else {
          await axios.post();
        }
      } else setCurrentStep(currentStep + 1);
    }
  };

  return (
    <s-section heading="Store Basics">
      <s-box paddingBlockEnd="base">
        <s-stack gap="tight">
          <s-select
            value={storeLanguage}
            onChange={(value) => setStoreLanguage(value)}
            aria-label="Store language"
            label="Store language"
          >
            {LANGUAGES.map((language) => (
              <s-option key={language} value={language}>
                {language}
              </s-option>
            ))}
          </s-select>
        </s-stack>
      </s-box>
      <s-h4 style={{ margin: "0px", marginBottom: "12px" }}>
        Product Selection:
      </s-h4>
      <div
        style={{
          display: "flex",

          gap: "2px",
          margin: "12px 0px",
          alignItems: "center",
        }}
      >
        {tabs.map((tab, index) => (
          <s-button
            key={index}
            onClick={() => {
              setSelectedTab(tab);
              setError(false);
            }}
            size="large"
            selected={selectedTab === tab}
            variant={selectedTab === tab ? "primary" : "subtle"}
          >
            {tab}
          </s-button>
        ))}
      </div>{" "}
      <s-divider />
      {selectedTab === "Old Products" && (
        <OldProduct
          setSelected={setSelected}
          products={products}
          selected={selected}
          renderAltText={renderAltText}
          renderMedia={renderMedia}
          truncateString={truncateString}
          error={error}
        />
      )}
      {selectedTab === "Import new Products" && (
        <NewProduct
          link={link}
          error={error}
          setLink={setLink}
          selectedService={selectedService}
          setSelectedService={setSelectedService}
        />
      )}
      <div
        style={{ display: "flex", justifyContent: "end", marginTop: "12px" }}
      >
        <s-button
          variant="primary"
          disabled={isDisabled}
          onClick={() => {
            handleSubmit();
          }}
        >
          Continue
        </s-button>
      </div>
    </s-section>
  );
}
