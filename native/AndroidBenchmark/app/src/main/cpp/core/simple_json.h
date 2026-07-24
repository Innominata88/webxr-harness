#pragma once

#include <cstddef>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace native_benchmark::json {

class Error final : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

class Value {
public:
    using Array = std::vector<Value>;
    using Object = std::map<std::string, Value, std::less<>>;

    Value();
    explicit Value(bool value);
    explicit Value(double value);
    explicit Value(std::string value);
    explicit Value(Array value);
    explicit Value(Object value);

    bool isNull() const;
    bool isBool() const;
    bool isNumber() const;
    bool isString() const;
    bool isArray() const;
    bool isObject() const;

    bool asBool() const;
    double asNumber() const;
    const std::string& asString() const;
    const Array& asArray() const;
    const Object& asObject() const;
    const Value& at(std::string_view key) const;
    const Value* find(std::string_view key) const;

private:
    using Storage = std::variant<
        std::nullptr_t,
        bool,
        double,
        std::string,
        Array,
        Object
    >;
    Storage storage_;
};

Value parse(std::string_view source);

}  // namespace native_benchmark::json
