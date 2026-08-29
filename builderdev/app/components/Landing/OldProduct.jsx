import { ProductIcon } from "@shopify/polaris-icons";
const OldProduct = ({
  setSelected,
  selected,
  renderAltText,
  renderMedia,
  truncateString,
  products,
  error,
}) => {
  return (
    <>
      <s-text>Old Products:</s-text>
      {error ? (
        <p style={{ color: "#c62828" }}>
          Select the product you want to generate a store for *
        </p>
      ) : (
        <s-paragraph color="subdued">
          Select the product you want to generate a store for
        </s-paragraph>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
          gap: "24px",
          maxHeight: "300px",
          overflowY: "auto",

          paddingTop: "12px",

          borderRadius: "12px",
          border: "1px dashed #e0e0e0",
        }}
      >
        {products.map((product, index) => {
          const image = product?.node?.featuredImage;
          const title = product?.node?.title;
          const handle = product?.node?.handle;
          return (
            <s-box
              key={index}
              padding="base"
              borderWidth="base"
              borderColor={selected === index ? "strong" : "base"}
              borderRadius="base"
              background={selected === index ? "strong" : "base"}
              display="flex"
              width="max-content"
              onClick={() => setSelected(index)}
              style={{
                borderColor: selected === index ? "#000" : "base",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  marginInline: "auto",
                  gap: "8px",
                  width: "100%",
                  cursor: "pointer",
                }}
              >
                {image?.url ? (
                  <s-image
                    src={renderMedia(image?.url)}
                    alt={renderAltText(image?.altText)}
                    borderRadius="large"
                  />
                ) : (
                  <ProductIcon />
                )}
                <s-text>{truncateString(title, 20)}</s-text>
                <s-paragraph>{truncateString(handle, 20)}</s-paragraph>
              </div>
            </s-box>
          );
        })}
      </div>
    </>
  );
};
export default OldProduct;
