import alibaba from "../../assets/alibaba.png";
import aliexpress from "../../assets/aliexpress.png";
import amazon from "../../assets/amazon.png";
import custom from "../../assets/custom.webp";
import etsy from "../../assets/etsy.webp";
import shopify from "../../assets/shopify.svg";

const NewProduct = ({
  link,
  setLink,
  error,
  selectedService,
  setSelectedService,
}) => {
  const services = [
    { id: "shopify", name: "Shopify", img: shopify },
    { id: "aliexpress", name: "AliExpress", img: aliexpress },
    { id: "amazon", name: "Amazon", img: amazon },
    { id: "alibaba", name: "Alibaba", img: alibaba },
    { id: "etsy", name: "Etsy", img: etsy },
    { id: "custom", name: "Custom website", img: custom },
  ];

  return (
    <s-stack gap="base">
      <s-text emphasis="strong">Product source</s-text>

      <s-paragraph>
        Select a service where you want to import a product from
      </s-paragraph>

      {/* Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
          gap: "16px",
        }}
      >
        {services.map((service) => {
          const isSelected = selectedService === service.name;

          return (
            <s-box
              key={service.id}
              padding="base"
              borderRadius="base"
              borderWidth={isSelected ? "large" : "base"}
              borderColor={isSelected ? "strong" : "subdued"}
              background="default"
              onClick={() => setSelectedService(service.name)}
              role="radio"
              aria-checked={isSelected}
              tabIndex={0}
              style={{
                transition: "all 0.15s ease",
                boxShadow: isSelected
                  ? "1px 1px 1px 2px var(--s-color-border-accent-subdued)"
                  : "none",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  cursor: "pointer",
                }}
              >
                {/* Radio indicator */}
                <div
                  style={{
                    width: "20px",
                    height: "18px",
                    borderRadius: "100%",
                    border: isSelected ? "2px solid #000" : "2px solid #c4c4c4",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {isSelected && (
                    <div
                      style={{
                        width: "8px",
                        height: "8px",
                        maxWidth: "8px",
                        borderRadius: "50%",
                        backgroundColor: "#000",
                      }}
                    />
                  )}
                </div>

                {/* Logo */}
                <img
                  src={service.img}
                  alt={service.name}
                  style={{
                    width: "32px",
                    height: "32px",
                    objectFit: "contain",
                  }}
                />

                {/* Label */}
                <s-text emphasis={isSelected ? "strong" : undefined}>
                  {service.name}
                </s-text>
              </div>
            </s-box>
          );
        })}
      </div>
      <div style={{ width: "100%", display: "flex", flexDirection: "column" }}>
        <label
          htmlFor="productLink"
          style={{
            display: "block",
            fontWeight: 600,
            marginBottom: "6px",
            color: error ? "#c62828" : "",
          }}
        >
          {selectedService} Product link:
        </label>

        <input
          id="productLink"
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
          }}
          type="text"
          placeholder={`Please enter a valid ${selectedService} product link`}
          style={{
            padding: "8px 10px",
            borderRadius: "6px",
            border: "1px solid #c4c4c4",
            fontSize: "14px",
          }}
        />
      </div>
    </s-stack>
  );
};

export default NewProduct;
